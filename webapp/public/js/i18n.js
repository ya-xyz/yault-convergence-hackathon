/**
 * i18n.js — UI translations for en / zh / ko / ja
 * Usage: load before portal scripts; call t('key') for translated string.
 * Set locale via setLocale('en'|'zh'|'ko'|'ja'); persisted in localStorage.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'yault_locale';
  var FALLBACK = 'en';

  var messages = {
    en: {
      appTitle: 'Yault',
      portalNavLabel: 'Choose portal',
      tabClient: 'Client',
      tabAuthority: 'Authority',
      tabOps: 'Operations',
      loading: 'Loading…',
      errorPortalLoad: 'Portal failed to load.',
      errorPortalScript: 'Failed to load portal script.',
      langEn: 'English',
      langZh: '中文',
      langKo: '한국어',
      langJa: '日本語',
      login: 'Login',
      connectWallet: 'Connect Wallet',
      dashboard: 'Dashboard',
      wallet: 'Wallet',
      accounts: 'Accounts',
      protection: 'Asset Plan',
      claim: 'Claim',
      activity: 'Activity',
      settings: 'Settings',
      overview: 'Overview',
      triggers: 'Triggers',
      initiate: 'Initiate',
      revenue: 'Revenue',
      users: 'Users',
      authorities: 'Authorities',
      kyc: 'KYC',
      logout: 'Log out',
      submit: 'Submit',
      cancel: 'Cancel',
      save: 'Save',
      close: 'Close',
      success: 'Success',
      error: 'Error',
      connected: 'Connected',
      loginFailed: 'Login failed',
      releaseSetup: 'Release Setup',
      trialApply: 'Apply for trial',
      signInWithYallet: 'Sign in with Yallet to access the dashboard.',
      platformOps: 'Platform Operations Dashboard',
      loadingWallet: 'Loading wallet connector…',
      language: 'Language',
      backToAssetPlan: 'Back to Asset Plan',
      selectChainAddress: 'Select Chain / Address',
      selectChainDesc: 'Switch the option below to view the address and assets for that chain (multi-chain addresses are saved when you sign in with Yallet).',
      currentAddress: 'Current Address',
      chainAssets: 'Chain Assets',
      balanceNotAvailable: '(On-chain balance not yet connected; showing 0)',
      firmSelectHint: 'You may select only one authority. Choose a jurisdiction and search; once selected you cannot add another. To change, Remove first.',
      firmAlreadySelected: 'One authority already selected; to change, Remove first.',
      firmRequiredWarning: 'Please select at least one authority before proceeding to the next step.',
      firmRequiredReview: 'Please click Back above to return to the previous step and select at least one authority before submitting.',
      signCountPrompt: 'You will need to sign {count} time(s) (one per recipient). Please wait.',
      continueBtn: 'Continue',
      cannotGetAddress: 'Unable to get current wallet address',
      recipientNoWallet: 'Some selected recipients have not yet linked a Yallet wallet. Please confirm in "Accounts" that they have registered and linked.',
      ethMainnet: 'Ethereum Mainnet',
      sepoliaTestnet: 'Sepolia Testnet',
    },
    zh: {
      appTitle: 'Yault',
      portalNavLabel: '选择门户',
      tabClient: '用户端',
      tabAuthority: '机构端',
      tabOps: '运营端',
      loading: '加载中…',
      errorPortalLoad: '门户加载失败。',
      errorPortalScript: '无法加载门户脚本。',
      langEn: 'English',
      langZh: '中文',
      langKo: '한국어',
      langJa: '日本語',
      login: '登录',
      connectWallet: '连接钱包',
      dashboard: '概览',
      wallet: '钱包',
      accounts: '账户',
      protection: '资产规划',
      claim: '认领',
      activity: '动态',
      settings: '设置',
      overview: '概览',
      triggers: '触发',
      initiate: '发起',
      revenue: '收入',
      users: '用户',
      authorities: '机构',
      kyc: 'KYC',
      logout: '退出',
      submit: '提交',
      cancel: '取消',
      save: '保存',
      close: '关闭',
      success: '成功',
      error: '错误',
      connected: '已连接',
      loginFailed: '登录失败',
      releaseSetup: '释放设置',
      trialApply: '申请试用',
      signInWithYallet: '使用 Yallet 登录以访问控制台。',
      platformOps: '平台运营控制台',
      loadingWallet: '正在加载钱包连接器…',
      language: '语言',
      backToAssetPlan: '返回资产规划',
      selectChainAddress: '选择链 / 地址',
      selectChainDesc: '切换下方选项可查看该链地址及其资产（多链地址来自 Yallet 登录时保存）。',
      currentAddress: '当前地址',
      chainAssets: '该链资产',
      balanceNotAvailable: '（暂未对接链上余额，显示为 0）',
      firmSelectHint: '仅能选择一家机构。请选择司法辖区并搜索，选中后不可再添加或重复选择。如需更换请先 Remove。',
      firmAlreadySelected: '已选一家机构；如需更换请先 Remove。',
      firmRequiredWarning: '请至少选择一家机构后再进入下一步。',
      firmRequiredReview: '请点击上方 Back 返回上一步，至少选择一家机构后再提交。',
      signCountPrompt: '您需要进行 {count} 次签名（因为有 {count} 个接收人），请等待。',
      continueBtn: '继续',
      cannotGetAddress: '无法获取当前钱包地址',
      recipientNoWallet: '所选接收人中有人尚未绑定 Yallet 钱包，请先在「账户」中确认其已注册并绑定',
      ethMainnet: 'Ethereum 主网',
      sepoliaTestnet: 'Sepolia 测试网',
    },
    ko: {
      appTitle: 'Yault',
      portalNavLabel: '포털 선택',
      tabClient: '클라이언트',
      tabAuthority: '기관',
      tabOps: '운영',
      loading: '로딩 중…',
      errorPortalLoad: '포털을 불러오지 못했습니다.',
      errorPortalScript: '포털 스크립트를 불러오지 못했습니다.',
      langEn: 'English',
      langZh: '中文',
      langKo: '한국어',
      langJa: '日本語',
      login: '로그인',
      connectWallet: '지갑 연결',
      dashboard: '대시보드',
      wallet: '지갑',
      accounts: '계정',
      protection: '자산 계획',
      claim: '청구',
      activity: '활동',
      settings: '설정',
      overview: '개요',
      triggers: '트리거',
      initiate: '시작',
      revenue: '수익',
      users: '사용자',
      authorities: '기관',
      kyc: 'KYC',
      logout: '로그아웃',
      submit: '제출',
      cancel: '취소',
      save: '저장',
      close: '닫기',
      success: '성공',
      error: '오류',
      connected: '연결됨',
      loginFailed: '로그인 실패',
      releaseSetup: '릴리스 설정',
      trialApply: '체험 신청',
      signInWithYallet: 'Yallet로 로그인하여 대시보드에 접속합니다.',
      platformOps: '플랫폼 운영 대시보드',
      loadingWallet: '지갑 연결 로딩 중…',
      language: '언어',
      backToAssetPlan: '자산 계획으로 돌아가기',
      selectChainAddress: '체인 / 주소 선택',
      selectChainDesc: '아래 옵션을 전환하여 해당 체인의 주소와 자산을 확인할 수 있습니다 (다중 체인 주소는 Yallet 로그인 시 저장됩니다).',
      currentAddress: '현재 주소',
      chainAssets: '체인 자산',
      balanceNotAvailable: '(온체인 잔액이 아직 연결되지 않았습니다; 0으로 표시)',
      firmSelectHint: '하나의 기관만 선택할 수 있습니다. 관할권을 선택하고 검색하세요. 선택 후 추가하거나 중복 선택할 수 없습니다. 변경하려면 먼저 Remove하세요.',
      firmAlreadySelected: '이미 하나의 기관이 선택되었습니다. 변경하려면 먼저 Remove하세요.',
      firmRequiredWarning: '다음 단계로 진행하기 전에 최소 하나의 기관을 선택하세요.',
      firmRequiredReview: '위의 Back을 클릭하여 이전 단계로 돌아가 최소 하나의 기관을 선택한 후 제출하세요.',
      signCountPrompt: '{count}번의 서명이 필요합니다 (수신자 {count}명에 대해 각각). 잠시 기다려 주세요.',
      continueBtn: '계속',
      cannotGetAddress: '현재 지갑 주소를 가져올 수 없습니다',
      recipientNoWallet: '선택된 수신자 중 Yallet 지갑을 연결하지 않은 사람이 있습니다. "계정"에서 등록 및 연결을 확인하세요.',
      ethMainnet: 'Ethereum 메인넷',
      sepoliaTestnet: 'Sepolia 테스트넷',
    },
    ja: {
      appTitle: 'Yault',
      portalNavLabel: 'ポータルを選択',
      tabClient: 'クライアント',
      tabAuthority: '機関',
      tabOps: '運用',
      loading: '読み込み中…',
      errorPortalLoad: 'ポータルの読み込みに失敗しました。',
      errorPortalScript: 'ポータルスクリプトの読み込みに失敗しました。',
      langEn: 'English',
      langZh: '中文',
      langKo: '한국어',
      langJa: '日本語',
      login: 'ログイン',
      connectWallet: 'ウォレット接続',
      dashboard: 'ダッシュボード',
      wallet: 'ウォレット',
      accounts: 'アカウント',
      protection: '資産プラン',
      claim: '請求',
      activity: 'アクティビティ',
      settings: '設定',
      overview: '概要',
      triggers: 'トリガー',
      initiate: '開始',
      revenue: '収益',
      users: 'ユーザー',
      authorities: '機関',
      kyc: 'KYC',
      logout: 'ログアウト',
      submit: '送信',
      cancel: 'キャンセル',
      save: '保存',
      close: '閉じる',
      success: '成功',
      error: 'エラー',
      connected: '接続済み',
      loginFailed: 'ログインに失敗しました',
      releaseSetup: 'リリース設定',
      trialApply: 'トライアル申込',
      signInWithYallet: 'Yalletでサインインしてダッシュボードにアクセス。',
      platformOps: 'プラットフォーム運用ダッシュボード',
      loadingWallet: 'ウォレット接続を読み込み中…',
      language: '言語',
      backToAssetPlan: '資産プランに戻る',
      selectChainAddress: 'チェーン / アドレスを選択',
      selectChainDesc: '下のオプションを切り替えて、そのチェーンのアドレスと資産を確認できます（マルチチェーンアドレスはYalletサインイン時に保存されます）。',
      currentAddress: '現在のアドレス',
      chainAssets: 'チェーン資産',
      balanceNotAvailable: '（オンチェーン残高はまだ接続されていません。0と表示されます）',
      firmSelectHint: '選択できる機関は1つだけです。管轄地域を選択して検索してください。選択後は追加や重複選択はできません。変更するにはまずRemoveしてください。',
      firmAlreadySelected: '機関が1つ選択済みです。変更するにはまずRemoveしてください。',
      firmRequiredWarning: '次のステップに進む前に、少なくとも1つの機関を選択してください。',
      firmRequiredReview: '上のBackをクリックして前のステップに戻り、少なくとも1つの機関を選択してから送信してください。',
      signCountPrompt: '{count}回の署名が必要です（受取人{count}人分）。お待ちください。',
      continueBtn: '続ける',
      cannotGetAddress: '現在のウォレットアドレスを取得できません',
      recipientNoWallet: '選択された受取人の中にYalletウォレットをリンクしていない人がいます。「アカウント」で登録とリンクを確認してください。',
      ethMainnet: 'Ethereum メインネット',
      sepoliaTestnet: 'Sepolia テストネット',
    },
  };

  function getStored() {
    try {
      var s = localStorage.getItem(STORAGE_KEY);
      if (s && messages[s]) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function detectBrowser() {
    var lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (lang.indexOf('zh') === 0) return 'zh';
    if (lang.indexOf('ko') === 0) return 'ko';
    if (lang.indexOf('ja') === 0) return 'ja';
    return 'en';
  }

  // #SUGGESTION: Default to 'en' instead of browser detection to ensure English is the default.
  var current = getStored() || 'en';

  function setLocale(lang) {
    if (!messages[lang]) lang = FALLBACK;
    current = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) { /* ignore */ }
    if (typeof window.onYaultLocaleChange === 'function') {
      window.onYaultLocaleChange(lang);
    }
  }

  function t(key) {
    var m = messages[current];
    if (!m) m = messages[FALLBACK];
    return m[key] != null ? m[key] : (messages[FALLBACK][key] != null ? messages[FALLBACK][key] : key);
  }

  function getLocale() {
    return current;
  }

  window.YaultI18n = {
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    messages: messages,
  };
  window.t = t;
})();
