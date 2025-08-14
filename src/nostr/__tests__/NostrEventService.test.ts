import { NostrEventService } from '../NostrEventService';
import { NDKEvent, NDKSigner } from '@nostr-dev-kit/ndk';
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('NostrEventService', () => {
  let service: NostrEventService;
  let mockSigner: NDKSigner;
  let mockEvent: NDKEvent;

  beforeEach(() => {
    // Create mock signer
    mockSigner = {
      sign: vi.fn(),
      user: vi.fn(),
      blockUntilReady: vi.fn()
    } as any;

    // Create mock event
    mockEvent = {
      kind: 1,
      content: 'test content',
      tags: [],
      sign: vi.fn(),
      publish: vi.fn(),
      id: 'test-event-id'
    } as any;

    service = new NostrEventService(mockSigner);
  });

  describe('signAndPublishEvent', () => {
    it('should sign and publish event successfully', async () => {
      await service.signAndPublishEvent(mockEvent);

      expect(mockEvent.sign).toHaveBeenCalledWith(mockSigner);
      expect(mockEvent.publish).toHaveBeenCalled();
    });

    it('should throw error when no signer is available', async () => {
      const serviceWithoutSigner = new NostrEventService();
      
      await expect(serviceWithoutSigner.signAndPublishEvent(mockEvent))
        .rejects.toThrow('No signer available for NostrEventService');
    });

    it('should propagate signing errors', async () => {
      const signError = new Error('Signing failed');
      mockEvent.sign.mockRejectedValue(signError);

      await expect(service.signAndPublishEvent(mockEvent))
        .rejects.toThrow('Signing failed');
    });

    it('should propagate publishing errors', async () => {
      const publishError = new Error('Publishing failed');
      mockEvent.publish.mockRejectedValue(publishError);

      await expect(service.signAndPublishEvent(mockEvent))
        .rejects.toThrow('Publishing failed');
    });
  });

  describe('setSigner', () => {
    it('should update the signer', async () => {
      const newSigner = {
        sign: vi.fn(),
        user: vi.fn(),
        blockUntilReady: vi.fn()
      } as any;

      const serviceWithoutSigner = new NostrEventService();
      serviceWithoutSigner.setSigner(newSigner);

      // Should now work with the new signer
      await serviceWithoutSigner.signAndPublishEvent(mockEvent);
      expect(mockEvent.sign).toHaveBeenCalledWith(newSigner);
    });
  });

  describe('publishEvent', () => {
    it('should publish already signed event', async () => {
      await service.publishEvent(mockEvent);
      expect(mockEvent.publish).toHaveBeenCalled();
    });

    it('should propagate publishing errors for already signed events', async () => {
      const publishError = new Error('Network error');
      mockEvent.publish.mockRejectedValue(publishError);

      await expect(service.publishEvent(mockEvent))
        .rejects.toThrow('Network error');
    });
  });
});