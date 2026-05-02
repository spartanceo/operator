/**
 * Arabic (AR) translation bundle — RTL.
 *
 * Initial machine-drafted translation per Task #28. Awaiting human review
 * before launch. Mirror the shape of `en.ts` exactly. The locale registry
 * (`src/i18n/locales.ts`) marks `ar` as `rtl: true`, which flips the
 * document direction via the `LocaleProvider`.
 */

import type { TranslationShape } from "./en";

export const ar: TranslationShape = {
  common: {
    appName: "أومنينيتي أوبراتور",
    download: "تنزيل OP",
    learnMore: "اعرف المزيد",
    loading: "جارٍ التحميل…",
    close: "إغلاق",
    cancel: "إلغاء",
  },
  nav: {
    product: "المنتج",
    marketplace: "السوق",
    pricing: "الأسعار",
    creators: "المبدعون",
    docs: "التوثيق",
    openMenu: "فتح القائمة",
    navigation: "التنقل",
  },
  footer: {
    columns: {
      product: "المنتج",
      resources: "الموارد",
      creators: "المبدعون",
      company: "الشركة",
      legal: "قانوني",
    },
    links: {
      whatItDoes: "ما يفعله",
      download: "تنزيل",
      pricing: "الأسعار",
      skillMarketplace: "سوق المهارات",
      releaseNotes: "ملاحظات الإصدار",
      documentation: "التوثيق",
      skillSdk: "مجموعة تطوير المهارات",
      apiReference: "مرجع واجهة البرمجة",
      troubleshooting: "استكشاف الأخطاء",
      becomeCreator: "كن مبدعًا",
      marketplacePolicy: "سياسة السوق",
      revenueShare: "مشاركة الإيرادات",
      featuredSkills: "المهارات المميزة",
      about: "نبذة",
      manifesto: "البيان",
      pressKit: "حزمة الصحافة",
      contact: "اتصل بنا",
      privacy: "الخصوصية",
      terms: "الشروط",
      eula: "اتفاقية ترخيص المستخدم النهائي",
      euAiAct: "قانون الذكاء الاصطناعي الأوروبي",
      openSourceLicences: "تراخيص المصدر المفتوح",
    },
    tagline:
      "صُمم للأشخاص الذين يريدون استعادة أدواتهم. محلي أولاً، قابل للتراجع افتراضيًا، مخلص للشخص أمام لوحة المفاتيح.",
    copyright:
      "© {{year}} Omninity, PBC. الطبقة التشغيلية الخاصة لحاسوبك.",
    statusQuiet: "جميع الأنظمة هادئة.",
    socials: {
      github: "GitHub",
      twitter: "Twitter",
      discord: "Discord",
      rss: "RSS",
    },
  },
  a11y: {
    skipToContent: "تخطَّ إلى المحتوى الرئيسي",
    languageSelector: "اختر اللغة",
    currentLanguage: "اللغة الحالية: {{language}}",
    openLanguageMenu: "تغيير اللغة",
  },
  settings: {
    title: "الإعدادات",
    description: "اضبط بيئة التشغيل والنماذج وهوية مساحة العمل.",
    save: "حفظ",
    reset: "إعادة تعيين",
    loading: "جارٍ التحميل…",
    appearance: {
      title: "المظهر",
      description: "بدّل بين السمة الداكنة والفاتحة. يستمر عبر الجلسات.",
      darkMode: "الوضع الداكن",
      currently: "الحالي: {{theme}}",
    },
    language: {
      title: "اللغة",
      description:
        "اختر اللغة المستخدمة في واجهة Operator بأكملها. يُطبَّق التغيير على الفور — لا حاجة لإعادة التشغيل.",
      label: "لغة الواجهة",
    },
    runtime: {
      title: "بيئة التشغيل",
      description: "نقطة نهاية Ollama والنموذج الافتراضي الذي تستخدمه الوكلاء.",
      ollamaUrl: "عنوان Ollama",
      defaultModel: "النموذج الافتراضي",
      cloudMode: "وضع السحابة",
      cloudModeDescription:
        "السماح بالرجوع إلى نموذج مستضاف عندما يكون النموذج المحلي غير متاح.",
    },
    workspace: {
      title: "مساحة العمل",
      description:
        "هوية المستأجر المُرسَلة مع كل طلب API، ومسار نظام الملفات المحلي الذي يمكن لأدوات الملفات الوصول إليه.",
      tenantId: "معرّف المستأجر",
      workspaceId: "معرّف مساحة العمل",
      workspacePath: "مسار مساحة العمل",
    },
    pull: {
      title: "تحميل نموذج مخصص",
      description:
        "جميع النماذج المحلية التي يبلّغ عنها Ollama، بالإضافة إلى تحميل يدوي للنماذج خارج الكتالوج المنسّق (متقدّم).",
      installed: "مثبّتة محليًا",
      noModels: "لا توجد نماذج مُبلَّغ عنها.",
      label: "تحميل نموذج بالاسم",
      placeholder: "مثال: llama3.1:8b",
      action: "تحميل",
      actionPending: "جارٍ التحميل…",
      queued: "تم وضع التحميل في الانتظار: {{name}} ({{status}})",
    },
    account: {
      title: "الحساب",
      description: "المعلومات التي يُرجعها GET /api/auth/me.",
      notSignedIn:
        "لم يتم تسجيل الدخول. ستصل المصادقة في إصدار لاحق — يُستخدم رأس المستأجر في الوقت الحالي.",
    },
  },
};
