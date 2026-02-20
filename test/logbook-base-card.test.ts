import { describe, expect, test, vi, beforeEach } from 'vitest';
import { ExtendedHomeAssistant } from '../src/types';
import { LogbookBaseCard } from '../src/logbook-base-card';

// Minimal concrete subclass of LogbookBaseCard for testing
class TestCard extends LogbookBaseCard {
  public updateHistoryCalls = 0;
  public updateHistory(): void {
    this.updateHistoryCalls++;
  }
  // Expose protected method for testing
  public callSubscribeToEntityStateChanges(entities: string[]): void {
    this.subscribeToEntityStateChanges(entities);
  }
}
customElements.define('test-logbook-card', TestCard);

const createMockHass = () => {
  const eventHandlers: Map<string, ((event: any) => void)[]> = new Map();

  return {
    connection: {
      subscribeEvents: vi.fn(async (callback: (event: any) => void, eventType?: string) => {
        const type = eventType || '*';
        if (!eventHandlers.has(type)) {
          eventHandlers.set(type, []);
        }
        eventHandlers.get(type)!.push(callback);

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
      // Helper to simulate a state_changed event arriving over the websocket
      _triggerStateChanged: (entityId: string) => {
        const handlers = eventHandlers.get('state_changed');
        if (handlers) {
          const event = {
            event_type: 'state_changed',
            data: { entity_id: entityId, new_state: null, old_state: null },
            origin: 'LOCAL',
            time_fired: new Date().toISOString(),
            context: { id: 'ctx', parent_id: null, user_id: null },
          };
          handlers.forEach(h => h(event));
        }
      },
    },
  } as unknown as ExtendedHomeAssistant & { connection: { _triggerStateChanged: (id: string) => void } };
};

describe('LogbookBaseCard state_changed subscription', () => {
  let mockHass: ReturnType<typeof createMockHass>;
  let card: TestCard;

  beforeEach(() => {
    mockHass = createMockHass();
    card = document.createElement('test-logbook-card') as TestCard;
    (card as any).hass = mockHass;
  });

  test('should subscribe to state_changed events for tracked entities', async () => {
    card.callSubscribeToEntityStateChanges(['light.living_room']);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockHass.connection.subscribeEvents).toHaveBeenCalledWith(
      expect.any(Function),
      'state_changed',
    );
  });

  test('should call updateHistory when a tracked entity state changes', async () => {
    card.callSubscribeToEntityStateChanges(['light.living_room']);
    await new Promise(resolve => setTimeout(resolve, 0));

    (mockHass.connection as any)._triggerStateChanged('light.living_room');

    expect(card.updateHistoryCalls).toBe(1);
  });

  test('should not call updateHistory for untracked entities', async () => {
    card.callSubscribeToEntityStateChanges(['light.living_room']);
    await new Promise(resolve => setTimeout(resolve, 0));

    (mockHass.connection as any)._triggerStateChanged('sensor.temperature');

    expect(card.updateHistoryCalls).toBe(0);
  });

  test('should not subscribe when entities array is empty', async () => {
    card.callSubscribeToEntityStateChanges([]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockHass.connection.subscribeEvents).not.toHaveBeenCalled();
  });

  test('should not subscribe when hass is not set', async () => {
    (card as any).hass = undefined;
    card.callSubscribeToEntityStateChanges(['light.living_room']);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockHass.connection.subscribeEvents).not.toHaveBeenCalled();
  });

  test('should replace previous subscription when called again', async () => {
    card.callSubscribeToEntityStateChanges(['light.living_room']);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Re-subscribe with a different entity
    card.callSubscribeToEntityStateChanges(['switch.kitchen']);
    await new Promise(resolve => setTimeout(resolve, 0));

    // The first entity should no longer trigger updates
    (mockHass.connection as any)._triggerStateChanged('light.living_room');
    expect(card.updateHistoryCalls).toBe(0);

    // The new entity should trigger updates
    (mockHass.connection as any)._triggerStateChanged('switch.kitchen');
    expect(card.updateHistoryCalls).toBe(1);
  });

  test('should track multiple entities with a single subscription', async () => {
    card.callSubscribeToEntityStateChanges(['light.living_room', 'switch.kitchen']);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Both entities should trigger updates
    (mockHass.connection as any)._triggerStateChanged('light.living_room');
    (mockHass.connection as any)._triggerStateChanged('switch.kitchen');

    expect(card.updateHistoryCalls).toBe(2);
    // Only one subscribeEvents call is made
    expect(mockHass.connection.subscribeEvents).toHaveBeenCalledTimes(1);
  });
});
