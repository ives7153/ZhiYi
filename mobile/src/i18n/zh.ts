/**
 * Chinese UI copy, transcribed from the Web app so the two clients read the same.
 *
 * Sources: `frontend/messages/zh-CN/{nav,auth,common,wardrobe,settings,constants}.json`.
 * Where the spec (docs/知衣-App开发规划.md §6) defines mobile-specific wording,
 * that wording is used and noted inline.
 *
 * Round-2 rule that is easy to break: user-facing strings must never contain a
 * backend status value (`ready`, `processing`, `tagged`, …) or an HTTP result.
 * The `itemStatus` block exists precisely so screens map those onto plain Chinese
 * rather than printing the enum.
 */

export const zh = {
  nav: {
    wardrobe: '衣橱',
    outfits: '搭配',
    toBuy: '待购',
    profile: '我的',
  },

  login: {
    title: '登录',
    subtitle: '登录以管理你的衣橱',
    email: '邮箱',
    displayName: '显示名称',
    namePlaceholder: '你的名字',
    signingIn: '登录中...',
    devMode: '开发模式 - 任意凭证均可登录',
    termsAgreement: '登录即表示您同意我们的服务条款和隐私政策。',
    backendErrorTitle: '后端配置错误',
    backendErrorDescription: '无法连接后端服务器。请检查后端是否正在运行。',
    unconfiguredTitle: '未配置任何认证方式',
    unconfiguredDescription:
      '如需使用 SSO，请设置 OIDC_ISSUER_URL + OIDC_CLIENT_ID；如需本地使用，请启用 DEBUG 模式。',
    oidcButton: '使用 SSO 登录',
    sessionExpired: '登录已过期，请重新登录',
  },

  wardrobe: {
    title: '衣橱',
    itemCount: (count: number) => `衣柜中有 ${count} 件单品`,
    search: '搜索单品...',
    searchAction: '搜索',
    addItem: '添加单品',
    loadMore: '加载更多',
    totalCount: (count: number) => `共 ${count} 件`,
    favorites: '收藏',
    needsWash: '需要清洗',
    allTypes: '所有类型',
    /** Card title when a garment has neither a name nor a usable type. */
    unnamedItem: '未命名单品',
    clearFilters: '清除筛选',
    wearCount: (count: number) => `已穿着 ${count} 次`,
    /** Grid overlay while the server is still tagging the item. */
    analyzing: 'AI 分析中...',
    empty: {
      title: '你的衣柜是空的',
      description: '添加你的第一件衣物，开始获取个性化穿搭建议。',
      addFirstItem: '添加第一件单品',
    },
    errors: {
      loadFailed: '加载单品失败，请重试。',
      noItemsFound: '没有找到符合筛选条件的单品。',
    },
    filters: {
      title: '筛选',
      favorites: '只看收藏',
      needsWash: '只看需清洗',
      apply: '应用筛选',
      onlyActive: '仅显示在衣橱中的单品',
    },
    sort: {
      title: '排序',
      newest: '最近添加',
      oldest: '最早添加',
      name: '按名称',
    },
  },

  /**
   * Add-item flow. Copy is written for a non-technical reader: the progress
   * messages describe what is happening to their garment, never a status enum or
   * an HTTP result. The spec requires the file-upload step and the AI step to be
   * visibly distinct, which is why `uploadingPhoto` and `analyzing` are separate
   * messages rather than one "processing" label.
   */
  addItem: {
    title: '添加单品',
    subtitle: '拍照或从相册选择衣物图片',
    pickFromLibrary: '从相册选择',
    takePhoto: '拍照',
    changePhoto: '更换照片',
    removePhoto: '移除照片',
    noPhotoYet: '还没有选择照片',
    detailsTitle: '衣物信息',
    detailsHint: '都可以稍后修改',
    nameLabel: '名称',
    namePlaceholder: '例如：白色棉质衬衫',
    typeLabel: '类别',
    typePlaceholder: '未选择（可稍后补充）',
    brandLabel: '品牌',
    brandPlaceholder: '选填',
    colorLabel: '颜色',
    notesLabel: '备注',
    notesPlaceholder: '选填',
    favoriteLabel: '加入收藏',
    favoriteOn: '已开启',
    favoriteOff: '已关闭',
    submit: '添加',
    submitting: '正在添加...',
    /** Shown after the bytes are sent but before the server has answered. */
    uploadingPhoto: '正在上传照片...',
    /** Distinct from the above: the upload succeeded and AI is working now. */
    analyzing: '正在识别衣物信息...',
    savedTitle: '已添加',
    /** `skip_ai` / AI-off path: the item is usable at once. */
    savedReady: '这件衣物已经可以使用了。',
    /** AI-on path: file is stored, tagging continues in the background. */
    savedAnalyzing: '照片已保存，正在后台识别类别和颜色。',
    savedAnalyzingHint: '识别需要一点时间，关闭这个页面也可以。',
    goToWardrobe: '返回衣橱',
    viewItem: '查看这件衣物',
    retryUpload: '重新上传',
    keepEditing: '继续编辑信息',
    /**
     * States exactly what survives a failure. The implementation keeps the form
     * state mounted across the error, so this claim is backed by behaviour.
     */
    inputKept: '照片和填写的信息都已保留，可以直接重试。',
    /** Shown while the same photo is being retried after a failure. */
    retrying: '正在重试...',
    errors: {
      pickFailed: '无法读取这张图片，请换一张试试。',
      prepareFailed: '图片处理失败，请换一张试试。',
      unsupportedFormat: '只支持 JPG、PNG、WebP 或 HEIC 格式的图片。',
      uploadFailed: '上传失败，请检查网络后重试。',
      saveFailed: '保存失败，请稍后重试。',
      duplicateTitle: '这张照片已存在',
      duplicate: '衣橱里已经有这张照片了，没有重复添加。可以在衣橱中直接找到它。',
      permissionTitle: '需要授权才能继续',
      permissionLibrary: '知衣需要访问相册才能选择衣物照片。',
      permissionLibraryBlocked: '相册权限已被拒绝，请在系统设置中允许后重试。',
      permissionCamera: '知衣需要使用相机才能拍照，请在系统设置中允许。',
      permissionCameraBlocked: '相机权限已被拒绝，请在系统设置中允许后重试。',
      permissionOpenSettings: '去设置中开启',
      partiallyFailed: (failed: number) => `有 ${failed} 张没能添加成功。`,
    },
  },

  /** Item detail actions and their confirmations. */
  itemActions: {
    edit: '编辑',
    save: '保存',
    saving: '保存中...',
    cancel: '取消',
    editTitle: '编辑衣物',
    archive: '归档',
    restore: '取消归档',
    delete: '删除',
    archived: '已归档',
    archiveTitle: '归档这件衣物',
    /**
     * Describes the real behaviour, which is narrower than "remove": the row and
     * its photos stay, and outfit links are untouched. Overstating this would be
     * a lie the user could catch simply by restoring the item.
     */
    archiveMessage:
      '归档后这件衣物不再出现在衣橱列表里，也不会再被用于生成搭配。衣物和照片都会保留，随时可以取消归档。',
    deleteTitle: '删除这件衣物',
    /**
     * `DELETE /items/{id}` cascades to `outfit_items` (`ON DELETE CASCADE`), so
     * the removal from existing outfits is real and must be stated beforehand.
     */
    deleteMessage:
      '删除后这件衣物和它的所有图片都会被永久移除，也无法再恢复。已经用到它的搭配会一并移除这件衣物。',
    deleteConfirm: '确认删除',
    saved: '已保存',
    saveFailed: '保存失败，请稍后重试。',
    archiveFailed: '归档失败，请稍后重试。',
    deleteFailed: '删除失败，请稍后重试。',
  },

  /**
   * Plain-Chinese wording for the two backend status fields.
   *
   * Screens map `item.status` / `item.tagging_status` through this table so the
   * raw enum never reaches the screen.
   */
  itemStatus: {
    processing: '识别中',
    ready: '可用',
    error: '识别失败',
    archived: '已归档',
    unknown: '状态未知',
    taggingPending: '待完善',
    taggingTagged: '已完善',
    taggingUnknown: '标注状态未知',
  },

  itemDetail: {
    title: '单品详情',
    type: '类型',
    subtype: '子类型',
    name: '名称',
    brand: '品牌',
    colors: '颜色',
    wearCount: '穿着次数',
    lastWornAt: '上次穿着',
    createdAt: '创建时间',
    status: '状态',
    taggingStatus: '标注状态',
    aiError: '分析失败原因',
    notFound: '未找到该单品',
    none: '—',
  },

  outfits: {
    title: '搭配',
    placeholder: '该功能将在后续版本提供',
    description: '插槽式搭配：按上装、下装、外套等席位组合穿搭并保存。',
  },

  toBuy: {
    title: '待购',
    placeholder: '该功能将在后续版本提供',
    description: '待购试搭：记录想买的单品，先与现有衣橱试搭再决定是否购买。',
  },

  profile: {
    title: '我的',
    accountSection: '账号',
    accountDescription: '您的个人资料信息',
    name: '名称',
    email: '邮箱',
    appSection: '应用信息',
    apiBaseUrl: '后端地址',
    version: '版本号',
    signOut: '退出登录',
    signOutConfirmTitle: '退出登录',
    signOutConfirmMessage: '确定要退出登录吗？本机保存的凭证和缓存数据将被清除。',
    cancel: '取消',
    confirm: '确认',
  },

  common: {
    retry: '重试',
    loading: '加载中...',
    back: '返回',
    error: '出了点问题',
    notFound: '页面未找到',
    done: '完成',
  },
} as const;

export type Strings = typeof zh;
