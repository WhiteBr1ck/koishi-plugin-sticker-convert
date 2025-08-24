import { Context, Schema, h, Logger, Session } from 'koishi'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs'
import { readFile, stat } from 'fs/promises'

export const name = 'sticker-convert'
export const inject = ['database']
export const usage = `
## QQ 表情转存插件

将 QQ 表情包转换为可保存的图片或文件格式。

### 使用方法
1. 回复包含表情的消息，发送 "表情转存" 即可转换并保存到相册
2. 回复包含表情的消息，发送 "表情转换" 仅转换不保存
3. 使用 "表情相册" 命令查看已保存的表情
4. 使用 "表情相册发送 <编号>" 重新发送指定表情
5. 使用 "表情相册删除 <编号>" 删除指定表情（需要权限）
6. 使用 "表情相册清空" 清空整个相册（需要权限）

### 权限管理
删除和清空操作的权限等级可在配置中自定义：
- 1级：普通用户
- 2级：信任用户  
- 3级：管理员（默认）
- 4级：群主
- 5级：机器人管理员

### 支持格式
- 静态图片（jpg/png/webp）：转为普通图片
- 动态图片（gif）：转为文件上传
- 官方表情（face）：转为文件上传
`

export interface Config {
  /** 是否启用群相册功能 */
  enableAlbum: boolean
  /** 启用相册功能的群组列表（为空表示全部群组） */
  albumEnabledGroups: string[]
  /** 相册最大容量（每个群组） */
  albumMaxSize: number
  /** 查看相册时是否同时发送所有表情图片 */
  albumShowImages: boolean
  /** 允许删除表情的最低权限等级 */
  deletePermissionLevel: number
  /** 静态图片发送方式 */
  staticImageMode: 'buffer' | 'file'
  /** GIF 发送方式 */
  gifMode: 'buffer' | 'file'
  /** 文件传输方式（与OneBot客户端之间） */
  fileTransferMode: 'buffer' | 'file'
  /** 是否启用调试日志 */
  debug: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableAlbum: Schema.boolean().default(true).description('是否启用群相册功能'),
    albumEnabledGroups: Schema.array(Schema.string()).role('table').description('启用相册功能的群组列表（为空表示全部群组启用）'),
    albumMaxSize: Schema.number().min(5).max(100).default(20).description('相册最大容量（每个群组）（最大100）'),
    albumShowImages: Schema.boolean().default(true).description('查看相册时是否同时发送所有表情图片'),
    deletePermissionLevel: Schema.union([
      Schema.const(1).description('1级：普通用户'),
      Schema.const(2).description('2级：信任用户'),
      Schema.const(3).description('3级：管理员'),
      Schema.const(4).description('4级：群主'),
      Schema.const(5).description('5级：机器人管理员')
    ]).default(3).description('允许删除表情的最低权限等级'),
  }).description('相册设置'),
  
  Schema.object({
    staticImageMode: Schema.union([
      Schema.const('buffer').description('直接发送图片（推荐）'),
      Schema.const('file').description('作为文件发送')
    ]).default('buffer').description('静态图片（jpg/png/webp）的发送方式'),
    gifMode: Schema.union([
      Schema.const('file').description('作为文件发送（推荐）'),
      Schema.const('buffer').description('直接发送图片')
    ]).default('file').description('GIF 动图的发送方式'),
    fileTransferMode: Schema.union([
      Schema.const('buffer').description('buffer模式：文件数据传给OneBot（推荐）'),
      Schema.const('file').description('file模式：文件路径传给OneBot（需同环境）')
    ]).default('buffer').description('与OneBot客户端的文件传输方式'),
  }).description('发送设置'),
  
  Schema.object({
    debug: Schema.boolean().default(false).description('是否启用调试日志（用于排查问题）'),
  }).description('调试设置'),
])

// 数据库模型
declare module 'koishi' {
  interface Tables {
    sticker_archive: StickerRecord
  }
}

export interface StickerRecord {
  id: number
  channelId: string
  md5: string
  ext: string
  mime: string
  size: number
  isGif: boolean
  fileName: string
  filePath: string
  uploaderId: string
  sourceMessageId: string
  createdAt: Date
}

const logger = new Logger('sticker-convert')

export function apply(ctx: Context, config: Config) {
  // 扩展数据库表
  ctx.model.extend('sticker_archive', {
    id: 'unsigned',
    channelId: 'string',
    md5: 'string',
    ext: 'string',
    mime: 'string',
    size: 'unsigned',
    isGif: 'boolean',
    fileName: 'string',
    filePath: 'string',
    uploaderId: 'string',
    sourceMessageId: 'string',
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 创建存储目录
  const storageDir = resolve(ctx.baseDir, 'data', 'sticker-convert')
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true })
  }

  /**
   * 下载图片到本地
   */
  async function downloadImage(url: string): Promise<{ buffer: Buffer, mime: string, size: number }> {
    try {
      const response = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 30000 })
      const buffer = Buffer.from(response)
      
      // 简单的 MIME 类型检测
      let mime = 'image/unknown'
      if (buffer.length >= 4) {
        const header = buffer.toString('hex', 0, 4)
        if (header.startsWith('89504e47')) mime = 'image/png'
        else if (header.startsWith('ffd8ff')) mime = 'image/jpeg'
        else if (header.startsWith('47494638')) mime = 'image/gif'
        else if (buffer.toString('ascii', 0, 4) === 'RIFF') mime = 'image/webp'
      }
      
      return { buffer, mime, size: buffer.length }
    } catch (error) {
      throw new Error(`下载失败: ${error.message}`)
    }
  }

  /**
   * 获取文件扩展名
   */
  function getExtFromMime(mime: string): string {
    const mimeMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp'
    }
    return mimeMap[mime] || 'jpg'
  }

  /**
   * 保存文件到本地
   */
  async function saveFile(buffer: Buffer, md5: string, ext: string): Promise<string> {
    const fileName = `${new Date().toISOString().split('T')[0]}-${md5}.${ext}`
    const filePath = resolve(storageDir, fileName)
    
    return new Promise((resolve, reject) => {
      const stream = createWriteStream(filePath)
      stream.write(buffer)
      stream.end()
      stream.on('finish', () => resolve(filePath))
      stream.on('error', reject)
    })
  }

  /**
   * 检查是否为 OneBot 平台
   */
  function isOneBotPlatform(session: Session): boolean {
    return session.platform === 'onebot'
  }

  /**
   * 检查当前群组是否启用相册功能
   */
  function isAlbumEnabledForGroup(channelId: string): boolean {
    if (!config.enableAlbum) {
      return false
    }
    
    // 如果没有配置具体群组，默认全部启用
    if (!config.albumEnabledGroups || config.albumEnabledGroups.length === 0) {
      return true
    }
    
    // 检查当前群组是否在启用列表中
    return config.albumEnabledGroups.includes(channelId)
  }

  /**
   * 检查并清理相册容量
   */
  async function checkAndCleanAlbum(channelId: string): Promise<void> {
    const records = await ctx.database
      .select('sticker_archive')
      .where({ channelId })
      .orderBy('createdAt', 'desc')
      .execute()

    if (records.length >= config.albumMaxSize) {
      debugLog('相册容量检查', { 
        current: records.length, 
        max: config.albumMaxSize,
        needClean: records.length - config.albumMaxSize + 1
      })

      // 删除最旧的表情
      const toDelete = records.slice(config.albumMaxSize - 1)
      for (const record of toDelete) {
        try {
          // 删除本地文件
          if (existsSync(record.filePath)) {
            unlinkSync(record.filePath)
            debugLog('删除旧文件', { filePath: record.filePath })
          }
          // 删除数据库记录
          await ctx.database.remove('sticker_archive', { id: record.id })
        } catch (error) {
          logger.warn('清理旧表情失败:', error)
        }
      }
      
      debugLog('相册清理完成', { deleted: toDelete.length })
    }
  }

  /**
   * 调试日志函数
   */
  function debugLog(message: string, data?: any) {
    if (config.debug) {
      if (data) {
        logger.info(`[DEBUG] ${message}`, data)
      } else {
        logger.info(`[DEBUG] ${message}`)
      }
    }
  }

  /**
   * 检查用户权限等级
   */
  function checkUserPermission(session: Session): number {
    // 私聊或没有用户信息，默认为普通用户
    if (session.isDirect || !session.author) {
      return 1
    }

    const roles = session.author.roles || []
    
    // 检查各种权限等级
    if (roles.includes('owner')) return 4 // 群主
    if (roles.includes('admin')) return 3 // 管理员
    if (roles.includes('trusted')) return 2 // 信任用户
    
    return 1 // 普通用户
  }

  /**
   * 检查用户是否有删除权限
   */
  function hasDeletePermission(session: Session): boolean {
    const userLevel = checkUserPermission(session)
    return userLevel >= config.deletePermissionLevel
  }

  /**
   * 发送文件的统一函数
   */
  async function sendFileWithName(session: Session, buffer: Buffer, fileName: string, filePath?: string, forceBuffer: boolean = false): Promise<void> {
    try {
      if (config.fileTransferMode === 'buffer' || forceBuffer) {
        // 缓冲区模式：先保存临时文件，再发送路径，但保持原始文件名
        const tempFileName = `temp_${Date.now()}_${fileName}`
        const tempPath = resolve(storageDir, tempFileName)
        await new Promise<void>((resolve, reject) => {
          const stream = createWriteStream(tempPath)
          stream.write(buffer)
          stream.end()
          stream.on('finish', () => resolve())
          stream.on('error', reject)
        })
        
        // 发送文件，但指定原始文件名
        await session.send(h.file(`file://${tempPath}`, { filename: fileName }))
        
        // 延迟删除临时文件
        setTimeout(() => {
          try {
            if (existsSync(tempPath)) {
              unlinkSync(tempPath)
            }
          } catch (error) {
            logger.warn('删除临时文件失败:', error)
          }
        }, 5000) // 5秒后删除
        
      } else {
        // 文件模式：发送文件路径，指定原始文件名
        if (!filePath) {
          throw new Error('文件模式需要已保存的文件路径')
        }
        const originalFileName = filePath.split(/[/\\]/).pop()! // 获取原始文件名
        await session.send(h.file(`file://${filePath}`, { filename: originalFileName }))
      }
    } catch (error) {
      debugLog('文件发送失败', { error: error.message })
      throw error
    }
  }

  /**
   * 转换表情核心逻辑（不保存到相册）
   */
  async function convertEmojiOnly(session: Session) {
    debugLog('开始转换表情（仅转换）', { 
      platform: session.platform, 
      channelId: session.channelId,
      userId: session.userId 
    })

    if (!isOneBotPlatform(session)) {
      debugLog('平台不支持', { platform: session.platform })
      return '此插件仅支持 QQ 平台（OneBot 适配器）'
    }

    const quote = session.quote
    if (!quote) {
      debugLog('没有回复消息')
      return '请回复包含表情的消息后使用此命令'
    }

    debugLog('找到回复消息', { 
      messageId: quote.messageId,
      elements: quote.elements?.length,
      elementTypes: quote.elements?.map(el => el.type),
      allElements: quote.elements
    })

    // 尝试查找不同类型的图片元素
    const images = h.select(quote.elements, 'img')
    const imageElements = h.select(quote.elements, 'image') 
    const mfaceElements = h.select(quote.elements, 'mface') // QQ 表情包
    const allImageLike = [...images, ...imageElements, ...mfaceElements]
    
    debugLog('提取图片元素', { 
      imgCount: images.length, 
      imageCount: imageElements.length,
      mfaceCount: mfaceElements.length,
      totalImageLike: allImageLike.length,
      imgElements: images.map(el => ({ type: el.type, attrs: el.attrs })),
      imageElements: imageElements.map(el => ({ type: el.type, attrs: el.attrs })),
      mfaceElements: mfaceElements.map(el => ({ type: el.type, attrs: el.attrs }))
    })
    
    if (allImageLike.length === 0) {
      debugLog('没有找到图片元素，显示所有元素详情', {
        allElementsDetail: quote.elements?.map(el => ({ 
          type: el.type, 
          attrs: el.attrs,
          children: el.children 
        }))
      })
      return '被回复的消息中没有找到图片表情'
    }

    const results: string[] = []
    let successCount = 0

    for (const img of allImageLike) {
      try {
        debugLog('处理图片', { type: img.type, attrs: img.attrs })
        
        // 根据不同类型获取 URL
        let url: string
        if (img.type === 'mface') {
          // QQ 表情包 URL 在 attrs.url
          url = img.attrs.url
        } else {
          // 普通图片 URL 在 attrs.src 或 attrs.url
          url = img.attrs.src || img.attrs.url
        }
        
        if (!url) {
          debugLog('图片URL无效', { type: img.type, attrs: img.attrs })
          results.push('⚠️ 发现无效图片链接')
          continue
        }

        debugLog('开始下载图片', { type: img.type, url })

        // 下载图片
        const { buffer, mime, size } = await downloadImage(url)
        const md5 = createHash('md5').update(buffer).digest('hex')
        const ext = getExtFromMime(mime)
        const isGif = mime === 'image/gif'

        debugLog('图片下载完成', { 
          size, 
          mime, 
          ext, 
          isGif, 
          md5: md5.substring(0, 8) + '...',
          convertOnly: true
        })

        const fileName = `temp-${md5.substring(0, 8)}.${ext}`

        // 根据类型和配置发送（仅转换，不保存）
        if (isGif) {
          // GIF 发送方式
          if (config.gifMode === 'file') {
            try {
              debugLog('尝试以文件方式发送GIF')
              
              // 仅转换模式强制使用 buffer 模式（因为没有保存文件）
              await sendFileWithName(session, buffer, fileName, undefined, true)
              
              debugLog('GIF文件发送成功')
              results.push(`🎞️ GIF 已转为文件: ${fileName}`)
            } catch (error) {
              debugLog('GIF文件发送失败，尝试作为图片发送', { error: error.message })
              // 如果文件发送失败，降级为图片发送
              await session.send(h.image(buffer, 'image/gif'))
              debugLog('GIF作为图片发送成功')
              results.push(`🎞️ GIF 已转换（作为图片发送）`)
            }
          } else {
            // 直接作为图片发送
            debugLog('以图片方式发送GIF')
            await session.send(h.image(buffer, 'image/gif'))
            debugLog('GIF图片发送成功')
            results.push(`🎞️ GIF 已转换为图片`)
          }
        } else {
          // 静态图片发送方式
          if (config.staticImageMode === 'file') {
            try {
              debugLog('尝试以文件方式发送静态图片')
              
              // 仅转换模式强制使用 buffer 模式（因为没有保存文件）
              await sendFileWithName(session, buffer, fileName, undefined, true)
              
              debugLog('静态图片文件发送成功')
              results.push(`📁 图片已转为文件: ${fileName}`)
            } catch (error) {
              debugLog('静态图片文件发送失败，尝试作为图片发送', { error: error.message })
              // 如果文件发送失败，降级为图片发送
              await session.send(h.image(buffer, mime))
              debugLog('静态图片作为图片发送成功')
              results.push(`🖼️ 图片已转换`)
            }
          } else {
            // 直接作为图片发送
            debugLog('以图片方式发送静态图片')
            await session.send(h.image(buffer, mime))
            debugLog('静态图片发送成功')
            results.push(`🖼️ 图片已转换`)
          }
        }

        debugLog('仅转换模式，不保存到相册')
        successCount++
      } catch (error) {
        debugLog('转换失败', { error: error.message, stack: error.stack })
        logger.error('转换失败:', error)
        results.push(`❌ 转换失败: ${error.message}`)
      }
    }

    if (successCount > 0) {
      results.unshift(`✅ 成功转换 ${successCount} 个表情`)
    }

    return results.join('\n')
  }

  /**
   * 转存表情核心逻辑
   */
  async function convertEmoji(session: Session) {
    debugLog('开始转存表情', { 
      platform: session.platform, 
      channelId: session.channelId,
      userId: session.userId 
    })

    if (!isOneBotPlatform(session)) {
      debugLog('平台不支持', { platform: session.platform })
      return '此插件仅支持 QQ 平台（OneBot 适配器）'
    }

    // 检查是否启用相册功能
    if (!isAlbumEnabledForGroup(session.channelId)) {
      debugLog('当前群组未启用相册功能')
      return '❌ 此群组未启用相册功能，无法使用转存功能。请使用 "表情转换" 命令进行临时转换。'
    }

    const quote = session.quote
    if (!quote) {
      debugLog('没有回复消息')
      return '请回复包含表情的消息后使用此命令'
    }

    debugLog('找到回复消息', { 
      messageId: quote.messageId,
      elements: quote.elements?.length,
      elementTypes: quote.elements?.map(el => el.type),
      allElements: quote.elements
    })

    // 尝试查找不同类型的图片元素
    const images = h.select(quote.elements, 'img')
    const imageElements = h.select(quote.elements, 'image') 
    const mfaceElements = h.select(quote.elements, 'mface') // QQ 表情包
    const allImageLike = [...images, ...imageElements, ...mfaceElements]
    
    debugLog('提取图片元素', { 
      imgCount: images.length, 
      imageCount: imageElements.length,
      mfaceCount: mfaceElements.length,
      totalImageLike: allImageLike.length,
      imgElements: images.map(el => ({ type: el.type, attrs: el.attrs })),
      imageElements: imageElements.map(el => ({ type: el.type, attrs: el.attrs })),
      mfaceElements: mfaceElements.map(el => ({ type: el.type, attrs: el.attrs }))
    })
    
    if (allImageLike.length === 0) {
      debugLog('没有找到图片元素，显示所有元素详情', {
        allElementsDetail: quote.elements?.map(el => ({ 
          type: el.type, 
          attrs: el.attrs,
          children: el.children 
        }))
      })
      return '被回复的消息中没有找到图片表情'
    }

    const results: string[] = []
    let successCount = 0

    for (const img of allImageLike) {
      try {
        debugLog('处理图片', { type: img.type, attrs: img.attrs })
        
        // 根据不同类型获取 URL
        let url: string
        if (img.type === 'mface') {
          // QQ 表情包 URL 在 attrs.url
          url = img.attrs.url
        } else {
          // 普通图片 URL 在 attrs.src 或 attrs.url
          url = img.attrs.src || img.attrs.url
        }
        
        if (!url) {
          debugLog('图片URL无效', { type: img.type, attrs: img.attrs })
          results.push('⚠️ 发现无效图片链接')
          continue
        }

        debugLog('开始下载图片', { type: img.type, url })

        // 下载图片
        const { buffer, mime, size } = await downloadImage(url)
        const md5 = createHash('md5').update(buffer).digest('hex')
        const ext = getExtFromMime(mime)
        const isGif = mime === 'image/gif'

        debugLog('图片下载完成', { 
          size, 
          mime, 
          ext, 
          isGif, 
          md5: md5.substring(0, 8) + '...'
        })

        // 检查是否已存在
        const existing = await ctx.database.get('sticker_archive', {
          channelId: session.channelId,
          md5
        })

        if (existing.length > 0) {
          debugLog('表情已存在', { existingId: existing[0].id })
          results.push(`📁 此表情已存在相册中（编号 ${existing[0].id}）`)
          continue
        }

        // 检查相册容量
        await checkAndCleanAlbum(session.channelId)

        // 保存文件到本地
        const filePath = await saveFile(buffer, md5, ext)
        const fileName = filePath.split(/[/\\]/).pop()!
        debugLog('文件保存完成', { filePath, fileName })

        // 根据类型和配置发送
        if (isGif) {
          // GIF 发送方式
          if (config.gifMode === 'file') {
            try {
              debugLog('尝试以文件方式发送GIF')
              await sendFileWithName(session, buffer, fileName, filePath)
              debugLog('GIF文件发送成功')
              results.push(`🎞️ GIF 已转为文件: ${fileName}`)
            } catch (error) {
              debugLog('GIF文件发送失败，尝试作为图片发送', { error: error.message })
              // 如果文件发送失败，降级为图片发送
              await session.send(h.image(buffer, 'image/gif'))
              debugLog('GIF作为图片发送成功')
              results.push(`🎞️ GIF 已转换（作为图片发送）`)
            }
          } else {
            // 直接作为图片发送
            debugLog('以图片方式发送GIF')
            await session.send(h.image(buffer, 'image/gif'))
            debugLog('GIF图片发送成功')
            results.push(`🎞️ GIF 已转换为图片`)
          }
        } else {
          // 静态图片发送方式
          if (config.staticImageMode === 'file') {
            try {
              debugLog('尝试以文件方式发送静态图片')
              await sendFileWithName(session, buffer, fileName, filePath)
              debugLog('静态图片文件发送成功')
              results.push(`📁 图片已转为文件: ${fileName}`)
            } catch (error) {
              debugLog('静态图片文件发送失败，尝试作为图片发送', { error: error.message })
              // 如果文件发送失败，降级为图片发送
              await session.send(h.image(buffer, mime))
              debugLog('静态图片作为图片发送成功')
              results.push(`🖼️ 图片已转换`)
            }
          } else {
            // 直接作为图片发送
            debugLog('以图片方式发送静态图片')
            await session.send(h.image(buffer, mime))
            debugLog('静态图片发送成功')
            results.push(`🖼️ 图片已转换`)
          }
        }

        // 记录到相册
        debugLog('保存到相册')
        await ctx.database.create('sticker_archive', {
          channelId: session.channelId,
          md5,
          ext,
          mime,
          size,
          isGif,
          fileName,
          filePath,
          uploaderId: session.userId,
          sourceMessageId: quote.messageId || '',
          createdAt: new Date()
        })
        debugLog('相册保存完成')

        successCount++
      } catch (error) {
        debugLog('转存失败', { error: error.message, stack: error.stack })
        logger.error('转存失败:', error)
        results.push(`❌ 转存失败: ${error.message}`)
      }
    }

    if (successCount > 0) {
      results.unshift(`✅ 成功转存 ${successCount} 个表情`)
    }

    return results.join('\n')
  }

  /**
   * 查看相册
   */
  async function viewAlbum(session: Session, page: number = 1) {
    if (!isAlbumEnabledForGroup(session.channelId)) {
      return '❌ 此群组未启用相册功能'
    }

    const pageSize = 8
    const offset = (page - 1) * pageSize

    const records = await ctx.database
      .select('sticker_archive')
      .where({ channelId: session.channelId })
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
      .offset(offset)
      .execute()

    if (records.length === 0) {
      return page === 1 ? '相册为空，快去转存一些表情吧！' : '没有更多表情了'
    }

    const total = await ctx.database
      .select('sticker_archive')
      .where({ channelId: session.channelId })
      .execute()

    const totalPages = Math.ceil(total.length / pageSize)
    
    let result = `📱 表情相册 (第 ${page}/${totalPages} 页，共 ${total.length} 个)\n\n`

    // 先发送文字信息
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const num = offset + i + 1
      result += `${num}. ${record.isGif ? '🎞️' : '🖼️'} ${record.fileName} (${(record.size / 1024).toFixed(1)}KB)\n`
    }

    result += `\n💡 使用 "表情相册发送 <编号>" 来重新发送指定表情`
    if (totalPages > 1) {
      result += `\n📄 使用 "表情相册 ${page + 1}" 查看下一页`
    }

    await session.send(result)

    // 根据配置决定是否发送图片
    if (config.albumShowImages) {
      for (const record of records) {
        try {
          if (existsSync(record.filePath)) {
            // 统一作为图片显示（包括GIF）
            const fileData = await readFile(record.filePath)
            await session.send(h.image(fileData, record.mime))
          }
        } catch (error) {
          logger.warn(`读取文件失败: ${record.filePath}`)
        }
      }
    }

    return ''
  }

  /**
   * 发送指定编号的表情
   */
  async function sendEmoji(session: Session, index: number) {
    if (!isAlbumEnabledForGroup(session.channelId)) {
      return '❌ 此群组未启用相册功能'
    }

    const records = await ctx.database
      .select('sticker_archive')
      .where({ channelId: session.channelId })
      .orderBy('createdAt', 'desc')
      .execute()

    if (index < 1 || index > records.length) {
      return `❌ 编号无效，相册中共有 ${records.length} 个表情`
    }

    const record = records[index - 1]
    
    if (!existsSync(record.filePath)) {
      return '❌ 文件不存在，可能已被删除'
    }

    try {
      const fileData = await readFile(record.filePath)

      if (record.isGif) {
        // GIF 按配置的方式发送
        if (config.gifMode === 'file') {
          try {
            await sendFileWithName(session, fileData, record.fileName, record.filePath)
            return `🎞️ 已发送 GIF 文件: ${record.fileName}`
          } catch (error) {
            // 如果文件发送失败，降级为图片发送
            await session.send(h.image(fileData, 'image/gif'))
            return `🎞️ 已发送 GIF（作为图片）: ${record.fileName}`
          }
        } else {
          // 直接作为图片发送
          await session.send(h.image(fileData, 'image/gif'))
          return `🎞️ 已发送 GIF 图片: ${record.fileName}`
        }
      } else {
        // 静态图片按配置的方式发送
        if (config.staticImageMode === 'file') {
          try {
            await sendFileWithName(session, fileData, record.fileName, record.filePath)
            return `📁 已发送图片文件: ${record.fileName}`
          } catch (error) {
            // 如果文件发送失败，降级为图片发送
            await session.send(h.image(fileData, record.mime))
            return `🖼️ 已发送图片: ${record.fileName}`
          }
        } else {
          // 直接作为图片发送
          await session.send(h.image(fileData, record.mime))
          return `🖼️ 已发送图片: ${record.fileName}`
        }
      }
    } catch (error) {
      logger.error('发送表情失败:', error)
      return `❌ 发送失败: ${error.message}`
    }
  }

  /**
   * 删除表情（权限可配置）
   */
  async function deleteEmoji(session: Session, index: number) {
    if (!isAlbumEnabledForGroup(session.channelId)) {
      return '❌ 此群组未启用相册功能'
    }

    // 检查用户权限
    if (!hasDeletePermission(session)) {
      const levelNames = ['', '普通用户', '信任用户', '管理员', '群主', '机器人管理员']
      return `❌ 权限不足，删除表情需要 ${levelNames[config.deletePermissionLevel]} 或以上权限`
    }

    const records = await ctx.database
      .select('sticker_archive')
      .where({ channelId: session.channelId })
      .orderBy('createdAt', 'desc')
      .execute()

    if (index < 1 || index > records.length) {
      return `❌ 编号无效，相册中共有 ${records.length} 个表情`
    }

    const record = records[index - 1]

    try {
      // 删除文件
      if (existsSync(record.filePath)) {
        unlinkSync(record.filePath)
      }

      // 删除数据库记录
      await ctx.database.remove('sticker_archive', { id: record.id })

      return `✅ 已删除表情: ${record.fileName}`
    } catch (error) {
      logger.error('删除表情失败:', error)
      return `❌ 删除失败: ${error.message}`
    }
  }

  /**
   * 清空相册（权限可配置）
   */
  async function clearAlbum(session: Session) {
    if (!isAlbumEnabledForGroup(session.channelId)) {
      return '❌ 此群组未启用相册功能'
    }

    // 检查用户权限
    if (!hasDeletePermission(session)) {
      const levelNames = ['', '普通用户', '信任用户', '管理员', '群主', '机器人管理员']
      return `❌ 权限不足，清空相册需要 ${levelNames[config.deletePermissionLevel]} 或以上权限`
    }

    const records = await ctx.database
      .select('sticker_archive')
      .where({ channelId: session.channelId })
      .execute()

    if (records.length === 0) {
      return '相册已经是空的了'
    }

    // 需要二次确认
    await session.send('⚠️ 确定要清空整个相册吗？此操作不可恢复！\n回复 "确认" 继续，其他内容取消')
    const confirm = await session.prompt(30000)
    
    if ((confirm as string)?.trim() !== '确认') {
      return '❌ 操作已取消'
    }

    try {
      // 删除所有文件
      for (const record of records) {
        if (existsSync(record.filePath)) {
          unlinkSync(record.filePath)
        }
      }

      // 删除数据库记录
      await ctx.database.remove('sticker_archive', { channelId: session.channelId })

      return `✅ 已清空相册，删除了 ${records.length} 个表情`
    } catch (error) {
      logger.error('清空相册失败:', error)
      return `❌ 清空失败: ${error.message}`
    }
  }

  // 注册命令
  ctx.command('表情转换', '转换表情格式（不保存到相册）')
    .action(async ({ session }) => {
      return await convertEmojiOnly(session)
    })

  ctx.command('表情转存', '转存表情到相册')
    .action(async ({ session }) => {
      return await convertEmoji(session)
    })

  ctx.command('表情相册 [page:number]', '查看表情相册')
    .action(async ({ session }, page = 1) => {
      return await viewAlbum(session, page)
    })

  ctx.command('表情相册发送 <index:number>', '发送指定编号的表情')
    .action(async ({ session }, index) => {
      if (!index) return '请指定表情编号'
      return await sendEmoji(session, index)
    })

  ctx.command('表情相册删除 <index:number>', '删除指定编号的表情（需要权限）')
    .action(async ({ session }, index) => {
      if (!index) return '请指定表情编号'
      return await deleteEmoji(session, index)
    })

  ctx.command('表情相册清空', '清空相册（需要权限）')
    .action(async ({ session }) => {
      return await clearAlbum(session)
    })
}
