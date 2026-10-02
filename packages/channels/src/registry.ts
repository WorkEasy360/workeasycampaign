import type { Channel } from '@workeasy/shared';
import type { ChannelAdapter } from './adapter.js';

/** Adding a channel = implement ChannelAdapter and register it here; nothing else in the pipeline changes. */
export class ChannelRegistry {
  private readonly adapters = new Map<Channel, ChannelAdapter>();

  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.channel, adapter);
    return this;
  }

  get(channel: Channel): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new Error(`No adapter registered for channel "${channel}"`);
    return adapter;
  }
}
