import mongoose from "mongoose";

const PaymentProvidersSchema = new mongoose.Schema(
  {
    stripe: {
      enabled: { type: Boolean, default: false },
      publicKey: { type: String },
    },
    razorpay: {
      enabled: { type: Boolean, default: false },
      keyId: { type: String },
    },
  },
  { _id: false },
);

const SocialLinkSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const PolicyItemSchema = new mongoose.Schema(
  {
    question: { type: String, default: "" },
    answer: { type: String, default: "" },
  },
  { _id: false },
);

const PolicySectionSchema = new mongoose.Schema(
  {
    heading: { type: String, default: "" },
    content: { type: String, default: "" },
  },
  { _id: false },
);

const ShowcaseTileSchema = new mongoose.Schema(
  {
    image: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    label: { type: String, default: "" },
    link: { type: String, default: "/" },
  },
  { _id: false },
);

const SettingsSchema = new mongoose.Schema({
  storeName: { type: String, default: "AppleBD" },
  storeEmail: { type: String, default: "" },
  footerInfo: {
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
  },
  contactInfo: {
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
  },
  socialLinks: {
    facebook: { type: SocialLinkSchema, default: () => ({}) },
    instagram: { type: SocialLinkSchema, default: () => ({}) },
    twitter: { type: SocialLinkSchema, default: () => ({}) },
    tiktok: { type: SocialLinkSchema, default: () => ({}) },
    youtube: { type: SocialLinkSchema, default: () => ({}) },
  },
  taxPercent: { type: Number, default: 0 },
  lowStockThreshold: { type: Number, default: 5 },
  defaultShipping: { type: Number, default: 0 },
  deliveryCharge: {
    insideDhaka: { type: Number, default: 70 },
    outsideDhaka: { type: Number, default: 130 },
    zones: {
      type: [
        {
          zone: { type: String, trim: true },
          charge: { type: Number, default: null },
          areas: {
            type: [
              {
                area: { type: String, trim: true },
                charge: { type: Number, default: null },
                _id: false,
              },
            ],
            default: [],
          },
          _id: false,
        },
      ],
      default: [],
    },
  },
  paymentProviders: { type: PaymentProvidersSchema, default: () => ({}) },
  cloudinaryFolder: { type: String, default: "applebd/products" },
  topBannerEnabled: { type: Boolean, default: false },
  topBannerHtml: { type: String, default: "" },
  topBannerConfig: {
    imageUrl: { type: String, default: "" },
    linkUrl: { type: String, default: "" },
    bgColor: { type: String, default: "" },
    text: { type: String, default: "" },
    height: { type: String, default: "" },
  },
  adsenseEnabled: { type: Boolean, default: false },
  adsensePublisherId: { type: String, default: "" },
  adsenseSlot: { type: String, default: "" },
  websiteLogo: {
    public_id: { type: String, default: "" },
    url: { type: String, default: "" },
    width: { type: Number },
    height: { type: Number },
    format: { type: String, default: "" },
  },
  footerLogo: {
    public_id: { type: String, default: "" },
    url: { type: String, default: "" },
    width: { type: Number },
    height: { type: Number },
    format: { type: String, default: "" },
  },
  websiteFavicon: {
    public_id: { type: String, default: "" },
    url: { type: String, default: "" },
    width: { type: Number },
    height: { type: Number },
    format: { type: String, default: "" },
  },
  megaMenuTags: [
    {
      name: { type: String, trim: true },
      href: { type: String, trim: true },
      icon: { type: String, trim: true },
      color: { type: String, trim: true },
      isActive: { type: Boolean, default: true },
      order: { type: Number, default: 0 },
    },
  ],
  productBadgeOptions: [
    {
      key: { type: String, trim: true, lowercase: true },
      label: { type: String, trim: true },
      color: { type: String, trim: true },
    },
  ],
  shipmentConfig: {
    pickupAddress: { type: String, default: "" },
    defaultCourierSlug: { type: String, default: "pathao" },
    bookSetsStatus: { type: String, default: "shipped" },
  },
  mobileBanking: {
    bkash: {
      enabled: { type: Boolean, default: false },
      merchantNumber: { type: String, default: "" },
      appKey: { type: String, default: "" },
      appSecret: { type: String, default: "" },
      username: { type: String, default: "" },
      password: { type: String, default: "" },
      mode: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
    },
    nagad: {
      enabled: { type: Boolean, default: false },
      merchantNumber: { type: String, default: "" },
      merchantId: { type: String, default: "" },
      merchantKey: { type: String, default: "" },
      mode: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
    },
    rocket: {
      enabled: { type: Boolean, default: false },
      merchantNumber: { type: String, default: "" },
      apiKey: { type: String, default: "" },
      mode: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
    },
  },
  facebookPixel: {
    pixelId: { type: String, default: "" },
    accessToken: { type: String, default: "" },
    testEventCode: { type: String, default: "" },
    browserSideTracking: { type: Boolean, default: true },
    serverSideTracking: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
  },
  googleTagManager: {
    containerId: { type: String, default: "" },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
  },
  googleAnalytics4: {
    measurementId: { type: String, default: "" },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
  },
  fakeOrderProtection: {
    phoneOrder: {
      enabled: { type: Boolean, default: true },
      limitDuration: { type: Number, default: 5 },
      limitDurationUnit: { type: String, default: "minutes" },
      blocklist: { type: String, default: "" },
    },
    ipOrder: {
      enabled: { type: Boolean, default: true },
      limitDuration: { type: Number, default: 5 },
      limitDurationUnit: { type: String, default: "minutes" },
      blocklist: { type: String, default: "" },
    },
    deviceOrder: {
      enabled: { type: Boolean, default: true },
      limitDuration: { type: Number, default: 5 },
      limitDurationUnit: { type: String, default: "minutes" },
    },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
  },
  tiktokPixel: {
    pixelId: { type: String, default: "" },
    accessToken: { type: String, default: "" },
    testEventCode: { type: String, default: "" },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
  },
  googleAdsense: {
    publisherId: { type: String, default: "" },
    adSlotId: { type: String, default: "" },
    autoAds: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    installed: { type: Boolean, default: false },
    pageSettings: {
      homepage: { type: Boolean, default: true },
      productPage: { type: Boolean, default: true },
      categoryPage: { type: Boolean, default: true },
      blogPage: { type: Boolean, default: true },
    },
  },
  customCode: {
    headerCode: { type: String, default: "" },
    bodyCode: { type: String, default: "" },
    footerCode: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  footerLinks: {
    quickLinks: [
      {
        label: { type: String, default: "" },
        href: { type: String, default: "" },
        _id: false,
      },
    ],
    customerService: [
      {
        label: { type: String, default: "" },
        href: { type: String, default: "" },
        _id: false,
      },
    ],
  },
  // Fully admin-editable footer brand block + bottom bar. Controls the
  // centered hero (headline, tagline, CTA buttons), the section headings,
  // the copyright line and the bottom legal links. Empty fields fall back to
  // the storefront's built-in translated defaults so older sites keep working.
  footerBrand: {
    headline: { type: String, default: "" },
    tagline: { type: String, default: "" },
    primaryCtaLabel: { type: String, default: "" },
    primaryCtaLink: { type: String, default: "/products" },
    accountCtaLabel: { type: String, default: "" },
    accountCtaLink: { type: String, default: "/user/profile" },
    loginCtaLabel: { type: String, default: "" },
    contactTitle: { type: String, default: "" },
    quickLinksTitle: { type: String, default: "" },
    followUsLabel: { type: String, default: "" },
    // {year} is replaced with the current year at render time
    copyright: { type: String, default: "" },
    bottomLinks: [
      {
        label: { type: String, default: "" },
        href: { type: String, default: "" },
        _id: false,
      },
    ],
  },
  // Fully admin-editable footer navigation columns (title + links).
  // When non-empty, these supersede the legacy footerLinks columns in the UI.
  footerColumns: [
    {
      title: { type: String, default: "" },
      links: [
        {
          label: { type: String, default: "" },
          href: { type: String, default: "" },
          _id: false,
        },
      ],
      _id: false,
    },
  ],
  policyContent: {
    shipping: { type: [PolicyItemSchema], default: [] },
    return: { type: [PolicyItemSchema], default: [] },
    faq: { type: [PolicyItemSchema], default: [] },
    privacy: { type: [PolicySectionSchema], default: [] },
    terms: { type: [PolicySectionSchema], default: [] },
  },
  aboutContent: {
    hero: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
    },
    features: {
      type: [
        {
          title: { type: String, default: "" },
          desc: { type: String, default: "" },
          _id: false,
        },
      ],
      default: [],
    },
    stats: {
      type: [
        {
          value: { type: String, default: "" },
          label: { type: String, default: "" },
          _id: false,
        },
      ],
      default: [],
    },
  },
  // homepage "Why Choose Us" section — fully admin-controlled: heading,
  // intro paragraph, side image, CTA pill, and its own FAQ/accordion items.
  // Rendered by components/home/WhyChooseUs.jsx. If `items` is empty the
  // section falls back to policyContent.faq so existing sites keep working.
  whyChooseUs: {
    enabled: { type: Boolean, default: true },
    title: { type: String, default: "" },
    titleBn: { type: String, default: "" },
    description: { type: String, default: "" },
    descriptionBn: { type: String, default: "" },
    image: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    // Up to 4 photos for the left-side collage. Falls back to `image` (and
    // then a built-in default) when empty, so older sites keep working.
    images: {
      type: [
        {
          url: { type: String, default: "" },
          public_id: { type: String, default: "" },
        },
      ],
      default: [],
    },
    buttonLabel: { type: String, default: "" },
    buttonLink: { type: String, default: "/about" },
    items: { type: [PolicyItemSchema], default: [] },
  },
  // homepage "Offers" section heading, e.g. "OFFERS! You Can't Miss!!"
  offersTitle: {
    highlight: { type: String, default: "OFFERS!" },
    rest: { type: String, default: "You Can't Miss!!" },
    highlightBn: { type: String, default: "OFFERS!" },
    restBn: { type: String, default: "You Can't Miss!!" },
  },
  // homepage "Deal of the Day" — admin-selected product
  dealOfDayProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    default: null,
  },
  // category-page heading + icon row, shown below the breadcrumb (Mac /
  // iPhone / iPad / … style quick category switcher), each icon links
  // wherever admin sets
  storeHero: {
    heading: { type: String, default: "Store." },
    subheading: {
      type: String,
      default: "The best way to buy the products you love.",
    },
    items: [
      new mongoose.Schema(
        {
          image: {
            url: { type: String, default: "" },
            public_id: { type: String, default: "" },
          },
          label: { type: String, default: "" },
          link: { type: String, default: "/" },
          isActive: { type: Boolean, default: true },
        },
        { _id: false },
      ),
    ],
  },
  // poster-style typographic hero shown above "Why Choose Us" on the
  // homepage: one giant display word with up to 4 admin-uploaded images
  // tucked between the letters. Rendered by components/home/TypographicHero.jsx.
  typographicHero: {
    enabled: { type: Boolean, default: true },
    word: { type: String, default: "GADGETS" },
    images: [
      new mongoose.Schema(
        {
          url: { type: String, default: "" },
          public_id: { type: String, default: "" },
        },
        { _id: false },
      ),
    ],
  },
  // homepage bento category showcase — each page has 6 slots:
  // [left big, 4 small in the middle, right big]; multiple pages = slider
  categoryShowcase: {
    // legacy single-page fields (kept for backward compat)
    title: { type: String, default: "Shop by Category" },
    categoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    tiles: [ShowcaseTileSchema],
    // current format: multiple showcase pages
    pages: [
      new mongoose.Schema(
        {
          title: { type: String, default: "" },
          tiles: [ShowcaseTileSchema],
        },
        { _id: false },
      ),
    ],
  },
  // Thin, very-small-height promotional strip shown in the homepage slot that
  // previously held Store Hero (the mini category-icon row). Direct-image only:
  // admin uploads a wide/short banner image (optional separate mobile image),
  // it becomes the whole clickable strip. Rendered by components/home/PromoBanner.jsx.
  promoBanner: {
    enabled: { type: Boolean, default: false },
    image: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    mobileImage: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    link: { type: String, default: "/products/" },
    // desktop strip height in px; keep it short for a premium thin banner
    height: { type: Number, default: 64 },
    // optional countdown timer overlaid at the top of the strip (flash-sale
    // style). timerEndsAt is a datetime-local string (e.g. "2026-09-10T18:00");
    // the storefront counts down to it and hides the timer once it passes.
    timerEnabled: { type: Boolean, default: false },
    timerEndsAt: { type: String, default: "" },
  },
  // Tabbed "Featured Products" showcase shown right after the category grid on
  // the homepage (Starbucks-style curved panel). Rendered by
  // components/home/FeaturedShowcase.jsx; served resolved via
  // GET /api/featured-showcase. Each tab is either an auto feed (latest / top
  // seller / featured flag / trending badge) or a manual hand-picked list.
  featuredShowcase: {
    enabled: { type: Boolean, default: true },
    title: { type: String, default: "Featured Products" },
    subtitle: {
      type: String,
      default: "Handpicked gadgets, refreshed for you.",
    },
    tabs: {
      type: [
        {
          label: { type: String, default: "" },
          // latest | top | featured | trending | manual
          type: { type: String, default: "latest" },
          productIds: [
            { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
          ],
          // Per-product showcase-image override for manual tabs. Maps a product
          // id (string) to the index of the product image the admin wants shown
          // as the big hero in the showcase. Missing/absent => storefront falls
          // back to the product's 2nd image (then 1st). Stored as a plain object
          // so it serialises cleanly to/from JSON on the admin editor.
          imageMap: { type: mongoose.Schema.Types.Mixed, default: {} },
          // Per-product "Add to cart" quantity for manual tabs. Maps a product
          // id (string) to how many units the Add-to-cart / Buy-now buttons add
          // at once. Missing => 1.
          qtyMap: { type: mongoose.Schema.Types.Mixed, default: {} },
          enabled: { type: Boolean, default: true },
        },
      ],
      default: undefined, // undefined => storefront falls back to default tabs
    },
  },
  updatedAt: { type: Date, default: Date.now },
});

SettingsSchema.pre("save", function () {
  this.updatedAt = Date.now();
});

export default mongoose.models.Setting ||
  mongoose.model("Setting", SettingsSchema);
