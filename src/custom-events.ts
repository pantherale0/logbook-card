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
    // This is a simplified version that handles basic variable substitution

    if (!template) {
      return JSON.stringify(event.data || event);
    }

    // Try to extract simple variable references like {{ variable }}
    // This is a simplified implementation - real Jinja2 would be much more complex
    try {
      let result = template;

      // Create a context object for template evaluation
      const context: any = {
        trigger: {
          payload_json: event.data || {},
        },
      };

      // Simple variable substitution for {{ variable }} patterns
      result = result.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, expr) => {
        try {
          // Clean up the expression
          expr = expr.trim();

          // Handle simple property access
          const parts = expr.split('.');
          let value: any = context;
          for (const part of parts) {
            const cleanPart = part.trim();
            if (value && typeof value === 'object' && cleanPart in value) {
              value = value[cleanPart];
            } else {
              return match; // Return original if can't resolve
            }
          }

          return String(value !== undefined && value !== null ? value : '');
        } catch {
          return match;
        }
      });

      // Handle basic filters like | default({})
      result = result.replace(/\|\s*default\([^)]*\)/g, '');

      return result || JSON.stringify(event.data || event);
    } catch (error) {
      console.error('Template rendering error:', error);
      return JSON.stringify(event.data || event);
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

  destroy(): void {
    this.unsubscribeAll();
    this.events = [];
  }
}
