import { CustomEvent, CustomEventConfig, ExtendedHomeAssistant } from './types';

export interface CustomEventHandler {
  eventType: string;
  config: CustomEventConfig;
  unsubscribe?: () => Promise<void>;
}

export class CustomEventManager {
  private handlers: Map<string, CustomEventHandler> = new Map();
  private events: CustomEvent[] = [];
  private maxEvents = 100; // Keep last 100 events per event type

  constructor(private hass: ExtendedHomeAssistant, private customConfig: { [eventType: string]: CustomEventConfig }) {}

  async subscribe(): Promise<void> {
    // Unsubscribe from existing handlers
    await this.unsubscribeAll();

    // Subscribe to each custom event
    for (const [eventType, config] of Object.entries(this.customConfig)) {
      await this.subscribeToEvent(eventType, config);
    }
  }

  private async subscribeToEvent(eventType: string, config: CustomEventConfig): Promise<void> {
    try {
      const unsubscribe = await this.hass.connection.subscribeEvents<any>(event => {
        this.handleEvent(eventType, config, event);
      }, eventType);

      this.handlers.set(eventType, {
        eventType,
        config,
        unsubscribe,
      });
    } catch (error) {
      console.error(`Failed to subscribe to event ${eventType}:`, error);
    }
  }

  private handleEvent(eventType: string, config: CustomEventConfig, event: any): void {
    try {
      // Create a custom event entry
      const customEvent: CustomEvent = {
        type: 'customEvent',
        event_type: eventType,
        name: config.name || eventType,
        message: this.renderTemplate(config.state_template || '', event),
        start: new Date(event.time_fired || new Date()),
        icon: config.icon,
      };

      // Add to events list
      this.events.push(customEvent);

      // Keep only the most recent events
      if (this.events.length > this.maxEvents) {
        this.events = this.events.slice(-this.maxEvents);
      }
    } catch (error) {
      console.error(`Error handling event ${eventType}:`, error);
    }
  }

  private renderTemplate(template: string, event: any): string {
    // For now, we'll do a simple template rendering
    // In a real implementation, we would use Home Assistant's template engine
    // This is a simplified version that handles basic Jinja2 patterns

    if (!template) {
      return JSON.stringify(event.data || event);
    }

    try {
      let result = template;

      // Create a context object for template evaluation
      const context: any = {
        trigger: {
          payload_json: event.data || {},
        },
      };

      // Handle {% set variable = value %} statements
      result = result.replace(/\{%\s*set\s+(\w+)\s*=\s*([^%]+)\s*%\}/g, (_match, varName, expr) => {
        try {
          const value = this.evaluateExpression(expr.trim(), context);
          context[varName] = value;
          return '';
        } catch {
          return '';
        }
      });

      // Handle {% if %} {% elif %} {% else %} {% endif %} blocks
      result = this.processConditionals(result, context);

      // Simple variable substitution for {{ variable }} patterns
      result = result.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, expr) => {
        try {
          return String(this.evaluateExpression(expr.trim(), context));
        } catch {
          return match;
        }
      });

      // Clean up extra whitespace
      result = result.replace(/\s+/g, ' ').trim();

      return result || JSON.stringify(event.data || event);
    } catch (error) {
      console.error('Template rendering error:', error);
      return JSON.stringify(event.data || event);
    }
  }

  private evaluateExpression(expr: string, context: any): any {
    // Handle filters like | default(...), | capitalize, etc.
    const filterMatch = expr.match(/^(.+?)\s*\|\s*(\w+)(?:\(([^)]*)\))?$/);
    if (filterMatch) {
      const [, baseExpr, filterName, filterArgs] = filterMatch;
      const value = this.evaluateExpression(baseExpr.trim(), context);
      return this.applyFilter(value, filterName, filterArgs, context);
    }

    // Handle property access like trigger.payload_json.data
    if (expr.includes('.')) {
      const parts = expr.split('.');
      let value: any = context;
      for (const part of parts) {
        const cleanPart = part.trim();
        if (value && typeof value === 'object' && cleanPart in value) {
          value = value[cleanPart];
        } else {
          return '';
        }
      }
      return value !== undefined && value !== null ? value : '';
    }

    // Handle direct variable reference
    if (expr in context) {
      return context[expr];
    }

    // Handle string literals
    if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
      return expr.slice(1, -1);
    }

    return '';
  }

  private applyFilter(value: any, filterName: string, filterArgs: string | undefined, context: any): any {
    switch (filterName) {
      case 'default':
        if (value === '' || value === null || value === undefined) {
          if (filterArgs) {
            // Try to parse the default value
            try {
              return this.evaluateExpression(filterArgs.trim(), context);
            } catch {
              return filterArgs;
            }
          }
          return '';
        }
        return value;
      case 'capitalize':
        if (!String(value)) return value;
        return (
          String(value)
            .charAt(0)
            .toUpperCase() + String(value).slice(1)
        );
      case 'upper':
        return String(value).toUpperCase();
      case 'lower':
        return String(value).toLowerCase();
      case 'tojson':
        return JSON.stringify(value);
      default:
        return value;
    }
  }

  private processConditionals(template: string, context: any): string {
    // Simple conditional processing
    // NOTE: This is a basic implementation for the initial release and won't handle nested
    // conditionals properly. Nested conditionals are excluded from the scope for now.
    // Future versions may add support for nested conditionals if needed.

    const conditionalRegex = /\{%\s*if\s+(.+?)\s*%\}([\s\S]*?)(?:\{%\s*elif\s+(.+?)\s*%\}([\s\S]*?))*(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g;

    return template.replace(conditionalRegex, (match, condition, trueBlock) => {
      try {
        // Extract elif and else blocks
        const parts = match.split(/\{%\s*(?:elif|else)\s*(?:[^%]+)?\s*%\}/);
        const conditions: string[] = [condition];
        const blocks: string[] = [trueBlock];

        // Extract elif conditions
        const elifMatches = match.matchAll(/\{%\s*elif\s+(.+?)\s*%\}/g);
        for (const elifMatch of elifMatches) {
          conditions.push(elifMatch[1]);
        }

        // Find elif and else blocks
        for (let i = 1; i < parts.length; i++) {
          const block = parts[i];
          if (block && block.trim()) {
            blocks.push(block);
          }
        }

        // Evaluate conditions
        for (let i = 0; i < conditions.length; i++) {
          if (this.evaluateCondition(conditions[i], context)) {
            return blocks[i] || '';
          }
        }

        // Return else block if exists
        if (blocks.length > conditions.length) {
          return blocks[blocks.length - 1];
        }

        return '';
      } catch (error) {
        console.error('Conditional processing error:', error);
        return '';
      }
    });
  }

  private evaluateCondition(condition: string, context: any): boolean {
    try {
      // Handle == comparison
      if (condition.includes('==')) {
        const [left, right] = condition.split('==').map(s => s.trim());
        const leftVal = this.evaluateExpression(left, context);
        const rightVal = this.evaluateExpression(right, context);
        return leftVal === rightVal;
      }

      // Handle != comparison
      if (condition.includes('!=')) {
        const [left, right] = condition.split('!=').map(s => s.trim());
        const leftVal = this.evaluateExpression(left, context);
        const rightVal = this.evaluateExpression(right, context);
        return leftVal !== rightVal;
      }

      // Simple truthiness check
      const value = this.evaluateExpression(condition, context);
      return Boolean(value);
    } catch {
      return false;
    }
  }

  getEvents(startDate: Date): CustomEvent[] {
    // Return events that occurred after startDate
    return this.events.filter(event => event.start >= startDate);
  }

  async unsubscribeAll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      if (handler.unsubscribe) {
        try {
          await handler.unsubscribe();
        } catch (error) {
          console.error(`Failed to unsubscribe from ${handler.eventType}:`, error);
        }
      }
    }
    this.handlers.clear();
  }

  async destroy(): Promise<void> {
    await this.unsubscribeAll();
    this.events = [];
  }
}
