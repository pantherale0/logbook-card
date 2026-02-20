import { CustomEvent, CustomEventConfig, ExtendedHomeAssistant } from './types';
import { HassEvent } from 'home-assistant-js-websocket/dist/types';

export interface CustomEventHandler {
  eventType: string;
  config: CustomEventConfig;
  unsubscribe?: () => Promise<void>;
}

interface MqttTriggerResult {
  variables: {
    trigger: {
      platform: 'mqtt';
      topic: string;
      payload: string;
      payload_json: any;
      qos: number;
    };
  };
  context: any;
}

export class CustomEventManager {
  private handlers: Map<string, CustomEventHandler> = new Map();
  private events: CustomEvent[] = [];
  private maxEvents = 100; // Keep last 100 events per event type
  private onEventCallback?: () => void;

  constructor(private hass: ExtendedHomeAssistant, private customConfig: { [eventType: string]: CustomEventConfig }) {}

  setOnEventCallback(callback: () => void): void {
    this.onEventCallback = callback;
  }

  async subscribe(): Promise<void> {
    // Unsubscribe from existing handlers
    await this.unsubscribeAll();

    // Subscribe to each custom event
    for (const [eventType, config] of Object.entries(this.customConfig)) {
      await this.subscribeToEvent(eventType, config);
    }
  }

  private isMqttTopic(eventType: string): boolean {
    // MQTT topics are identified by the presence of '/' (e.g. "zigbee2mqtt/bridge/event").
    // Home Assistant event bus event types follow a convention of lowercase with underscores
    // and do not contain '/' characters, making this a reliable discriminator.
    return eventType.includes('/');
  }

  private async subscribeToEvent(eventType: string, config: CustomEventConfig): Promise<void> {
    try {
      let unsubscribe: () => Promise<void>;

      if (this.isMqttTopic(eventType)) {
        // Subscribe to MQTT topic via HA trigger subscription
        unsubscribe = await this.hass.connection.subscribeMessage<MqttTriggerResult>(
          result => {
            this.handleMqttTrigger(eventType, config, result);
          },
          {
            type: 'subscribe_trigger',
            trigger: {
              platform: 'mqtt',
              topic: eventType,
            },
          } as any,
        );
      } else {
        // Subscribe to HA event bus event
        unsubscribe = await this.hass.connection.subscribeEvents<HassEvent>(event => {
          this.handleEvent(eventType, config, event);
        }, eventType);
      }

      this.handlers.set(eventType, {
        eventType,
        config,
        unsubscribe,
      });
    } catch (error) {
      console.error(`Failed to subscribe to event ${eventType}:`, error);
    }
  }

  private handleMqttTrigger(eventType: string, config: CustomEventConfig, result: MqttTriggerResult): void {
    try {
      const trigger = result?.variables?.trigger;
      const context: any = { trigger };
      const fallbackData = trigger?.payload_json ?? trigger?.payload ?? {};

      const customEvent: CustomEvent = {
        type: 'customEvent',
        event_type: eventType,
        name: config.name || eventType,
        message: this.renderTemplateWithContext(config.state_template || '', context, fallbackData),
        start: new Date(),
        icon: config.icon,
      };

      this.events.push(customEvent);

      if (this.events.length > this.maxEvents) {
        this.events = this.events.slice(-this.maxEvents);
      }

      this.onEventCallback?.();
    } catch (error) {
      console.error(`Error handling MQTT event ${eventType}:`, error);
    }
  }

  private handleEvent(eventType: string, config: CustomEventConfig, event: HassEvent): void {
    try {
      // Create a custom event entry
      const customEvent: CustomEvent = {
        type: 'customEvent',
        event_type: eventType,
        name: config.name || eventType,
        message: this.renderTemplate(config.state_template || '', event),
        start: new Date(event.time_fired),
        icon: config.icon,
      };

      // Add to events list
      this.events.push(customEvent);

      // Keep only the most recent events
      if (this.events.length > this.maxEvents) {
        this.events = this.events.slice(-this.maxEvents);
      }

      this.onEventCallback?.();
    } catch (error) {
      console.error(`Error handling event ${eventType}:`, error);
    }
  }

  private renderTemplate(template: string, event: HassEvent): string {
    if (!template) {
      return JSON.stringify(event.data);
    }

    const context: any = {
      trigger: {
        event: event,
        payload_json: event.data,
        platform: 'event',
        event_type: event.event_type,
      },
    };

    return this.renderTemplateWithContext(template, context, event.data);
  }

  private renderTemplateWithContext(template: string, context: any, fallbackData: any): string {
    if (!template) {
      return JSON.stringify(fallbackData);
    }

    try {
      let result = template;

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

      return result || JSON.stringify(fallbackData);
    } catch (error) {
      console.error('Template rendering error:', error);
      return JSON.stringify(fallbackData);
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

    // Use a simpler, safer regex pattern to avoid ReDoS vulnerability
    // Match the entire if...endif block without the problematic nested quantifiers
    const conditionalRegex = /\{%\s*if\s+([^%]+)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g;

    return template.replace(conditionalRegex, (_match, condition, content) => {
      try {
        // Split content by elif and else blocks
        const elifPattern = /\{%\s*elif\s+([^%]+)\s*%\}/g;
        const elsePattern = /\{%\s*else\s*%\}/;

        const conditions: string[] = [condition];
        const blocks: string[] = [];

        // Split by else first
        const [beforeElse, afterElse] = content.split(elsePattern);

        // If there's an else block, it will be the last block
        const elseBlock = afterElse !== undefined ? afterElse.trim() : null;

        // Split the before-else part by elif
        const parts = beforeElse.split(elifPattern);
        blocks.push(parts[0].trim()); // First if block

        // Extract elif conditions and blocks
        for (let i = 1; i < parts.length; i += 2) {
          if (i < parts.length - 1) {
            conditions.push(parts[i].trim()); // elif condition
            blocks.push(parts[i + 1].trim()); // elif block
          }
        }

        // Evaluate conditions in order
        for (let i = 0; i < conditions.length; i++) {
          if (this.evaluateCondition(conditions[i], context)) {
            return blocks[i] || '';
          }
        }

        // Return else block if exists
        return elseBlock || '';
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
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) {
      if (handler.unsubscribe) {
        try {
          await handler.unsubscribe();
        } catch (error) {
          console.error(`Failed to unsubscribe from ${handler.eventType}:`, error);
        }
      }
    }
  }

  async destroy(): Promise<void> {
    await this.unsubscribeAll();
    this.events = [];
  }
}
