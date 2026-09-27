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

  /**
   * Round 3: 插槽式搭配. Rounds 1 and 2 shipped this entry as an honest placeholder;
   * the copy below belongs to the real feature.
   *
   * Two rules carried over from the earlier rounds:
   *  - no backend value reaches the screen (`pending`, `external`, `unknown` … are all
   *    mapped first, see `src/api/outfitVocab.ts`);
   *  - the destructive confirmation states what actually happens — deleting an outfit
   *    removes the outfit only, so the copy may not imply the garments go with it.
   */
  outfits: {
    title: '搭配',
    subtitle: '按席位各选一件，保存成一套搭配',
    slotsSection: '席位',
    basicSlotsNote: '上衣、下装、鞋子是必须席位，外套和配饰可选',
    slotEmpty: '未选择',
    slotChoose: '选择单品',
    slotChange: '更换',
    swipeHint: '在席位上左右滑动，可以换一件同席位的单品',
    nextCandidate: '下一件',
    prevCandidate: '上一件',
    candidates: (index: number, total: number) => `第 ${index} / ${total} 件`,
    slotLoading: '正在加载候选单品...',
    slotLoadFailed: '候选单品加载失败，请重试。',
    slotNoItems: (slot: string) => `衣橱里还没有${slot}类别的单品`,
    slotNoItemsHint: '去衣橱添加一件，并在类别里选好对应类别。',
    slotNoMatch: '没有符合条件的单品',
    slotNoMatchHint: '换一个搜索词，或清空搜索后再看。',
    slotTruncated: '候选单品较多，这里只取到了最近的一部分。',
    unclassifiedNote: (count: number) =>
      `另有 ${count} 件单品的类别是「待分类」，无法放进任何席位；请先在衣橱里设置类别。`,
    fullBodyNote: '连衣裙、连体衣暂不支持搭配席位，请分别选择上衣和下装。',
    othersSection: '其他单品',
    othersNote: '这些单品不属于本轮的席位，保存时会原样保留。',
    nameLabel: '搭配名称',
    namePlaceholder: '例如：通勤三件套',
    unnamed: '未命名搭配',
    save: '保存搭配',
    saving: '正在保存...',
    saveNeedsItem: '至少选一件单品后再保存。',
    /** Non-blocking hint: the API only requires one item, but these slots are the base. */
    missingRequired: (slots: string) => `还没有选择：${slots}`,
    saveNameTooLong: (max: number) => `搭配名称不能超过 ${max} 个字符。`,
    saveFailed: '保存失败，请检查网络后重试。已经选好的单品不会丢失。',
    saveItemUnavailable:
      '保存失败：所选单品可能已被归档或正在识别中。请回到衣橱刷新后重新选择。',
    saveWornImmutable:
      '这套搭配已经穿过，服务端不允许再更换它的单品。可以改成新建一套搭配。',
    saveNotFound: '这套搭配已经不存在了（可能已在其他设备上删除）。',
    saveUncertainTitle: '保存结果不确定',
    saveUncertainMessage:
      '请求超时了，服务端可能已经保存了这套搭配。请先打开「已保存搭配」核对，不要直接重复保存，否则可能出现两套一样的搭配。',
    checkSaved: '查看已保存搭配',
    retrySave: '再试一次',
    savedListLink: '已保存搭配',
    savedTitle: '已保存搭配',
    savedCount: (count: number) => `共 ${count} 套搭配`,
    garmentCount: (count: number) => `${count} 件单品`,
    garmentNotInWardrobe: '这件单品已不在衣橱里（可能已归档）',
    unsupportedItem: '暂不支持席位',
    savedEmpty: '还没有保存过搭配',
    savedEmptyHint: '回到「搭配」页，按席位选好单品后保存。',
    savedSearch: '搜索搭配...',
    loadMore: '加载更多',
    loadFailed: '加载搭配失败，请重试。',
    notFound: '未找到该搭配',
    garmentUnnamed: '未命名单品',
    garmentArchived: '已归档',
    garmentUnclassified: '待分类',
    detailTitle: '搭配详情',
    detailItems: '单品',
    detailOccasion: '场合',
    detailStatus: '状态',
    detailCreatedAt: '创建时间',
    edit: '编辑搭配',
    editHint: '保存时只会替换这次改动的内容。',
    cancel: '取消',
    saved: '已保存',
    delete: '删除搭配',
    deleteTitle: '删除这套搭配',
    deleteMessage: '只会删除这套搭配本身，衣橱里的单品不会被删除。',
    deleteConfirm: '确认删除',
    deleteFailed: '删除失败，请稍后重试。',
    leaveTitle: '放弃当前搭配',
    leaveMessage: '这套搭配还没有保存，离开会丢失已经选好的单品。',
    leaveEditMessage: '这次修改还没有保存，离开会丢失。',
    leaveConfirm: '放弃并离开',
    keepEditing: '继续编辑',
    newOutfit: '新建搭配',
    imageFailed: '图片加载失败',
    pickerTitle: (slot: string) => `选择${slot}单品`,
    pickerSearch: '搜索单品...',
    pickerSearchAction: '搜索',
    pickerClose: '取消',
    pickerSelect: '选择',
    pickerSelected: '当前席位',
    pickerShown: (shown: number, total: number) => `已显示 ${shown} / ${total} 件`,
    pickerScrollMore: '向下滚动可看更多',
    pickerBackHint: '返回键可以先关闭这个面板',
    pickerKeepChoice: '取消后保持原来的选择',
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
