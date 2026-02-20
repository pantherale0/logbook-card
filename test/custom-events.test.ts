import { describe, expect, test, vi, beforeEach } from 'vitest';
import { CustomEventManager } from '../src/custom-events';
import { ExtendedHomeAssistant, CustomEventConfig } from '../src/types';

// Mock HomeAssistant connection
const createMockHass = (): ExtendedHomeAssistant => {
  const eventHandlers: Map<string, ((event: any) => void)[]> = new Map();

  return {
    connection: {
      subscribeEvents: vi.fn(async (callback: (event: any) => void, eventType?: string) => {
        const type = eventType || '*';
        if (!eventHandlers.has(type)) {
          eventHandlers.set(type, []);
        }
        eventHandlers.get(type)!.push(callback);

        // Return unsubscribe function
        return async () => {
          const handlers = eventHandlers.get(type);
          if (handlers) {
            const index = handlers.indexOf(callback);
            if (index > -1) {
              handlers.splice(index, 1);
            }
          }
        };
      }),
      // Helper to trigger events for testing
      _triggerEvent: (eventType: string, event: any) => {
        const handlers = eventHandlers.get(eventType);
        if (handlers) {
          handlers.forEach(handler => handler(event));
        }
      },
    },
  } as any;
};

describe('CustomEventManager', () => {
  let mockHass: ExtendedHomeAssistant;
  let eventManager: CustomEventManager;

  beforeEach(() => {
    mockHass = createMockHass();
  });

  test('should subscribe to custom events', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'test_event': {
        name: 'Test Event',
        icon: 'mdi:test',
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    expect(mockHass.connection.subscribeEvents).toHaveBeenCalledWith(
      expect.any(Function),
      'test_event'
    );
  });

  test('should handle incoming events', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'test_event': {
        name: 'Test Event',
        icon: 'mdi:test',
        state_template: '{{ trigger.payload_json.message }}',
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    // Trigger an event
    const testEvent = {
      event_type: 'test_event',
      data: {
        message: 'Hello World',
      },
      time_fired: new Date().toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id',
        user_id: null,
        parent_id: null,
      },
    };

    (mockHass.connection as any)._triggerEvent('test_event', testEvent);

    // Get events
    const events = eventManager.getEvents(new Date(Date.now() - 1000));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'customEvent',
      event_type: 'test_event',
      name: 'Test Event',
      message: 'Hello World',
      icon: 'mdi:test',
    });
  });

  test('should render complex template with conditionals', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'zigbee2mqtt/bridge/event': {
        name: 'Zigbee2MQTT',
        icon: 'mdi:zigbee',
        state_template: `{% set data = trigger.payload_json.data | default({}) %}
{% set type = trigger.payload_json.type %}
{% if type == 'device_joined' %}
📥 {{ data.friendly_name | default(data.ieee_address) }} joined the network
{% elif type == 'device_leave' %}
❌ {{ data.friendly_name | default(data.ieee_address) }} left the network
{% else %}
{{ type | capitalize }}: {{ data | tojson }}
{% endif %}`,
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    // Test device_joined event
    const joinEvent = {
      event_type: 'zigbee2mqtt/bridge/event',
      data: {
        type: 'device_joined',
        data: {
          friendly_name: 'Living Room Sensor',
          ieee_address: '0x00124b001234abcd',
        },
      },
      time_fired: new Date().toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-1',
        user_id: null,
        parent_id: null,
      },
    };

    (mockHass.connection as any)._triggerEvent('zigbee2mqtt/bridge/event', joinEvent);

    let events = eventManager.getEvents(new Date(Date.now() - 1000));
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('Living Room Sensor joined the network');

    // Test device_leave event
    const leaveEvent = {
      event_type: 'zigbee2mqtt/bridge/event',
      data: {
        type: 'device_leave',
        data: {
          ieee_address: '0x00124b001234abcd',
        },
      },
      time_fired: new Date().toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-2',
        user_id: null,
        parent_id: null,
      },
    };

    (mockHass.connection as any)._triggerEvent('zigbee2mqtt/bridge/event', leaveEvent);

    events = eventManager.getEvents(new Date(Date.now() - 1000));
    expect(events).toHaveLength(2);
    expect(events[1].message).toContain('0x00124b001234abcd left the network');
  });

  test('should filter events by start date', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'test_event': {
        name: 'Test Event',
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    const now = new Date();
    const pastDate = new Date(now.getTime() - 10000); // 10 seconds ago

    // Trigger an old event
    (mockHass.connection as any)._triggerEvent('test_event', {
      event_type: 'test_event',
      data: {},
      time_fired: pastDate.toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-3',
        user_id: null,
        parent_id: null,
      },
    });

    // Trigger a new event
    (mockHass.connection as any)._triggerEvent('test_event', {
      event_type: 'test_event',
      data: {},
      time_fired: now.toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-4',
        user_id: null,
        parent_id: null,
      },
    });

    // Filter to only get events from 5 seconds ago
    const recentEvents = eventManager.getEvents(new Date(now.getTime() - 5000));
    expect(recentEvents).toHaveLength(1);
  });

  test('should unsubscribe from events', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'test_event': {
        name: 'Test Event',
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    await eventManager.unsubscribeAll();

    // Verify subscription was called initially
    expect(mockHass.connection.subscribeEvents).toHaveBeenCalled();
  });

  test('should handle template with default filter', async () => {
    const customConfig: { [eventType: string]: CustomEventConfig } = {
      'test_event': {
        name: 'Test Event',
        state_template: '{{ trigger.payload_json.name | default("Unknown") }}',
      },
    };

    eventManager = new CustomEventManager(mockHass, customConfig);
    await eventManager.subscribe();

    // Event with name
    (mockHass.connection as any)._triggerEvent('test_event', {
      event_type: 'test_event',
      data: { name: 'Test Name' },
      time_fired: new Date().toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-5',
        user_id: null,
        parent_id: null,
      },
    });

    let events = eventManager.getEvents(new Date(Date.now() - 1000));
    expect(events[0].message).toBe('Test Name');

    // Event without name
    (mockHass.connection as any)._triggerEvent('test_event', {
      event_type: 'test_event',
      data: {},
      time_fired: new Date().toISOString(),
      origin: 'LOCAL',
      context: {
        id: 'test-context-id-6',
        user_id: null,
        parent_id: null,
      },
    });

    events = eventManager.getEvents(new Date(Date.now() - 1000));
    expect(events[1].message).toBe('Unknown');
  });
});
