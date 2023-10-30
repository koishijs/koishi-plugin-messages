import { Context, h, Quester, Schema, Universal } from 'koishi'
import { resolve } from 'path'
import { DataService } from '@koishijs/console'
import MessageService, { Message } from 'koishi-plugin-messages'
import {} from '@koishijs/assets'
import internal from 'stream'

interface SendPayload {
  content: string
  platform: string
  channelId: string
  guildId: string
}

interface HistoryPayload {
  platform: string
  channelId: string
  guildId: string
  id?: string
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      chat: ChatService
    }
  }

  interface Events {
    'chat/send'(this: Client, payload: SendPayload): Promise<void>
    'chat/history'(this: Client, payload: HistoryPayload): Promise<void>
    'chat/members'(this: Client, platform: string, guildId: string): Promise<Universal.List<Universal.GuildMember>>
  }
}

class ChatService extends DataService<MessageService.Data> {
  static inject = ['router', 'messages', 'console']

  constructor(ctx: Context, private config: ChatService.Config) {
    super(ctx, 'chat')
    const self = this

    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })

    ctx.console.addListener('chat/send', async ({ content, platform, channelId, guildId }) => {
      const key = `${platform}/${guildId}/${channelId}`
      const channel = ctx.messages._channels[key]
      if (ctx.assets) content = await ctx.assets.transform(content)
      ctx.bots[`${platform}:${channel.data.assignee}`]?.sendMessage(channelId, content, guildId)
    }, { authority: 4 })

    ctx.console.addListener('chat/history', async function ({ platform, channelId, guildId, id }) {
      self.logger.debug('fetching history of %s/%s/%s', platform, guildId, channelId)
      const channel = await ctx.messages.channel(platform, guildId, channelId)
      const key = `${platform}/${guildId}/${channelId}`
      const messages = await channel.getHistory(50, id)
      for (const message of messages) {
        self.transform(message)
      }
      this.send({
        type: 'chat/message',
        body: { key, messages, history: true },
      })
    }, { authority: 4 })

    ctx.console.addListener('chat/members', async function (platform, guildId) {
      const guild = ctx.messages.guild(platform, guildId)
      return guild.getMembers()
    })

    ctx.on('chat/update', () => {
      this.refresh()
    })

    ctx.on('chat/message', (messages, { data }) => {
      const key = `${data.platform}/${data.guildId}/${data.channelId}`
      for (const message of messages) {
        this.transform(message)
      }
      ctx.console.broadcast('chat/message', { key, messages }, { authority: 4 })
    })

    const { get } = ctx.http
    ctx.router.get('/chat/proxy/:url', async (ctx) => {
      if (!config.whitelist.some(prefix => ctx.params.url.startsWith(prefix))) {
        return ctx.status = 403
      }
      try {
        ctx.body = await get<internal.Readable>(ctx.params.url, { responseType: 'stream' })
      } catch (error) {
        if (!Quester.isAxiosError(error) || !error.response) throw error
        ctx.status = error.response.status
        ctx.body = error.response.data
      }
    })
  }

  private transform(message: Message) {
    message.content = h.transform(message.content, {
      image: (data) => {
        if (this.config.whitelist.some(prefix => data.url.startsWith(prefix))) {
          data.url = '/chat/proxy/' + encodeURIComponent(data.url)
        }
        return h('image', data)
      },
    })
  }

  async get() {
    return this.ctx.messages.toJSON()
  }
}

namespace ChatService {
  export interface Config {
    whitelist?: string[]
  }

  export const Config: Schema<Config> = Schema.object({
    whitelist: Schema.array(String).default([
      'https://gchat.qpic.cn/',
      'https://c2cpicdw.qpic.cn/',
    ]),
  })
}

export default ChatService
