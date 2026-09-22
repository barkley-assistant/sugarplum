/** Every user-facing copy string in the SPA, centralized so a writer pass
 *  edits exactly one file. Components import { S } and never hardcode a
 *  visible literal. Grouped by surface; keys that are not yet used are
 *  allowed to exist (they document the copy surface), literals in JSX are
 *  not. */

export const S = {
  app: {
    name: "sugarplum",
    tagline: "Private wishlists, shared with people you trust.",
    loading: "Loading…",
  },
  auth: {
    signIn: "Sign in",
    signingIn: "Signing in…",
    username: "Username",
    password: "Password",
    signOut: "Log out",
    invalidCredentials: "Invalid username or password.",
    signInFailed: "Sign-in failed.",
    tooManyAttempts: "Too many attempts. Try again later.",
    networkError: "Network error. Try again.",
  },
  list: {
    /** #121: the add flow's ONE "Add item" label — the feed CTA, the add
     *  page heading (the heading mirrors the affordance that navigated
     *  there; the submit button names the commit), and the add page's
     *  submit. Same words, three roles — #129's duplicate-CTA finding is
     *  about the bottom-bar tab, a same-role collision it owns. */
    addItem: "Add item",
    reorder: "Reorder",
    doneReordering: "Done",
    heading: (name: string) => `${name}'s wishlist`,
    itemCount: (n: number) => `${n} item${n === 1 ? "" : "s"}`,
    switcherLabel: "Switch wishlist",
  },
  item: {
    edit: "Edit",
    delete: "Delete",
    retry: "Retry fetch",
    notFound: "Item not found.",
    recheckPrice: "Re-check price",
    openDetails: "Open details",
    deltaSinceAdd: (amount: string) => `${amount} since added`,
    fetching: "Fetching details…",
    unavailable: "Details unavailable",
    hintPriceNote: "unverified — via search",
    lowestSeen: (price: string) => `Lowest ${price}`,
    /** #130: the current price IS the lowest seen — the row's quiet chip. */
    atLowest: "At lowest",
    /** #130: no price at all — the visible glyph is a dash; this is the
     *  accessible name a screen reader hears instead of "em dash". */
    priceUnavailable: "Price unavailable",
    atAddPrice: (price: string) => `At add ${price}`,
    pricesElsewhere: "Prices seen elsewhere (unverified)",
    checkingPrices: "Checking…",
    hintCandidateNote: "check before buying",
    hintsFootnote: "Automated search results. We can't confirm these are the same product or edition.",
    copyProductLink: "Copy product link",
    moreActions: "More actions",
    hintsNone: "No other prices found.",
    hintsDisabled: "Price hints are off in settings.",
    copyLink: "Copy link",
    copied: "Copied",
    imageViaSearch: "image via search",
  },
  detail: {
    openProduct: "Open product",
    editItem: "Edit item",
    notesTitle: "Notes",
    tagsTitle: "Tags",
    moreInfoTitle: "More information",
    checkElsewhere: "Check prices elsewhere",
    /** #113: the owner's saved "found it cheaper at" link, as a host label.
     *  Same phrase as the form field (S.form.cheaperLink) so the edit form
     *  and the surfaced row read as one concept. */
    cheaperAt: (host: string) => `Found it cheaper at ${host}`,
    addedOn: (date: string) => `Added ${date}`,
  },
  settings: {
    title: "Settings",
    /** #96 screen titles: the settings AREA is three routes, each with its
     *  own in-page heading (document.title stays "Settings · sugarplum"). */
    titleAccount: "Account & Preferences",
    titleUsers: "Users",
    titleNewUser: "New user",
    /** #96 navigation between the settings screens. */
    usersEntry: "Users",
    newUser: "New user",
    backToAccount: "Back to Account & Preferences",
    backToUsers: "Back to Users",
    account: "Account",
    usersSection: "Users",
    displayName: "Display name",
    saveProfile: "Save",
    profileSaved: "Profile updated.",
    changePassword: "Change password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    passwordMismatch: "New passwords do not match.",
    passwordChanged: "Password changed. Sign in again.",
    wrongPassword: "Current password is incorrect.",
    setPassword: "Set new password",
    backToList: "Back to list",
    openSettings: "Settings",
    preferences: "Preferences",
    hintsToggle: "Show unverified price hints",
    trackToggle: "Track prices daily",
    /** #98: the admin-only opt-in that reveals the user-management area. */
    usersToggle: "Show user management",
    on: "On",
    off: "Off",
  },
  trend: {
    windowLabel: "Trend window",
    window30d: "30d",
    window90d: "90d",
    below30dAvg: "Below 30-day average",
    near30dLow: "At 30-day low",
    near30dHigh: "Near 30-day high",
    trendingDown: "Trending down — could wait",
    stable: "Stable",
    insufficient: "Not enough history yet",
    /** #118: caption under a DRAWN chart when no trend is derivable yet.
     *  The literal "insufficient" copy stays exclusive to the no-chart
     *  empty state. */
    watching: "Watching for a trend",
  },
  priceHistory: {
    title: "Price history",
    graphLabel: (window: string, current: string, lowest: string) =>
      `Price over the last ${window}: now ${current}, lowest ${lowest}.`,
  },
  form: {
    title: "Title",
    price: "Price",
    currency: "Currency",
    currencyCode: "Code",
    link: "Link",
    cheaperLink: "Found it cheaper at",
    tags: "Tags",
    notes: "Notes",
    titlePlaceholder: "Leave blank to auto-fill from the link",
    pricePlaceholder: "24.99",
    currencyOther: "Other",
    currencyCodePlaceholder: "SEK",
    linkPlaceholder: "https://…",
    cheaperLinkPlaceholder: "https://…",
    tagsPlaceholder: "Birthday, Someday",
    cancel: "Cancel",
    /** #127: the guarded exit on the ADD form — rendered only while the form
     *  holds content a submit would send. "Cancel" stays the EDIT branch's
     *  label and the confirm dialog's reject label; one word, one job. */
    discard: "Discard",
    discardTitle: "Discard this item?",
    discardBody: "The details you entered will be lost.",
    saving: "Saving…",
    addSubmitBusy: "Adding…",
    save: "Save",
    addDetailsManually: "Add details manually",
    manualIntro: "Optional — we'll fetch the title, price and image from the link.",
    linkPlaceholderAdd: "Paste a product link…",
    needTitleOrLink: "Add a title or a link.",
  },
  claims: {
    claim: "Claim",
    unclaim: "Unclaim",
    claimedByYou: "Claimed by you",
    claimedBySomeone: "Claimed by someone",
  },
  share: {
    shareList: "Share my list",
    shareTitle: "Share your wishlist",
    shareIntro:
      "Anyone with this link can view your list and mark items as purchased. Purchased marks are never shown to you.",
    loading: "Loading…",
    copyLink: "Copy link",
    copied: "Copied",
    createLink: "Create link",
    creating: "Creating…",
    revoking: "Revoking…",
    regenerate: "New link",
    revoke: "Revoke link",
    regenerateConfirmTitle: "Create a new link?",
    regenerateConfirmBody:
      "The current link stops working immediately. Anyone you already sent it to will need the new one.",
    revokeConfirmTitle: "Revoke this link?",
    revokeConfirmBody: "Anyone with the link will no longer be able to view your list.",
    sharedByNote: "Shared list — no account needed",
    markPurchased: "Mark as purchased",
    markPurchasedTitle: "Mark as purchased?",
    markPurchasedBody:
      "This tells other viewers the item is already bought. It will not be shown to the list owner.",
    purchasedBadge: "Purchased",
    invalidLink: "This link is not valid or has been revoked.",
    retryLater: "Too many attempts. Try again later.",
    markFailed: "Could not mark that item.",
    resetPurchased: "Reset purchased mark",
    resetConfirmTitle: "Reset the purchased mark?",
    resetConfirmBody:
      "Purchased marks are anonymous. This clears the mark without telling you who set it.",
    ownerViewingOwn: "You are viewing your own shared list. Purchased marks are hidden from you.",
    /** #133: the guest share view's quiet end-of-content hook. The target is
     *  /login?next=/ — after signing in the visitor lands on their own list,
     *  which is what the copy promises. */
    signInHook: "Sign in to create your own wishlist",
  },
  owner: {
    /** #76: the owner's OWN purchased mark (distinct from the anonymous
     *  share-link flag whose copy lives in S.share). */
    mark: "Mark as purchased",
    markTitle: "Mark as purchased?",
    markBody:
      "Records that you already bought this. Only you can see and undo this mark.",
    unmark: "Unmark purchased",
    badge: "Bought by you",
  },
  admin: {
    name: "Name",
    username: "Username",
    status: "Status",
    actions: "Actions",
    adminRole: "admin",
    userRole: "user",
    inactiveSuffix: " · inactive",
    createUser: "Create user",
    creating: "Creating…",
    deactivate: "Deactivate",
    activate: "Activate",
    resetPassword: "Reset password",
    newPasswordFor: "New password",
    passwordPlaceholder: "New password",
    setPassword: "Set password",
    deleteUserConfirm: (username: string) => `Delete ${username}?`,
    deleteUserBody: "Their items and claims will be removed.",
    passwordReset: "Password reset.",
    userDeleted: "User deleted.",
    userCreated: "User created.",
    delete: "Delete",
    displayName: "Display name",
    password: "Password",
    isAdmin: "Admin",
    createFailed: "Could not create user.",
    requestFailed: "Request failed.",
    networkError: "Network error. Try again.",
  },
  pwa: {
    install: "Install app",
  },
  bar: {
    /** Visible labels on the mobile bottom action bar (#73). Add reuses the
     *  feed's action copy; Share is short (its accessible name stays
     *  "Share my list" via aria-label on the trigger). */
    add: "Add item",
    share: "Share",
    settings: "Settings",
    /** Landmark label for the bottom bar (screen readers announce
     *  "Primary actions navigation"). */
    navigation: "Primary actions",
  },
  tags: {
    all: "All",
    filterLabel: "Filter by tag",
  },
  errors: {
    loadWishlist: "Could not load your wishlist. Refresh to try again.",
    retryItem: "Could not retry that item.",
    checkPrices: "Could not check prices.",
    changeSettings: "Could not save that setting.",
    claimItem: "Could not claim that item.",
    unclaimItem: "Could not unclaim that item.",
    addItem: "Could not add item.",
    saveItem: "Could not save item.",
    deleteItem: "Could not delete item.",
    reorder: "Couldn't save the new order.",
    generic: "Something went wrong. Try again.",
  },
  empty: {
    own: "Nothing saved yet.",
    ownHint: "Paste a product link to start your list.",
    other: (name: string) => `${name} hasn't added anything yet.`,
    filtered: (tag: string) => `No items with tag "${tag}"`,
    clearFilter: "Clear filter",
  },
  dnd: {
    /** Drag-handle label. Per-item by default (A10) so a screen-reader user
     *  can tell the rows apart; falls back when a row still has no title. */
    moveItem: "Move item",
    moveItemNamed: (title: string) => `Move "${title}"`,
  },
  confirm: {
    deleteItem: (title: string) => `Delete "${title}"?`,
    deleteItemBody: "This cannot be undone.",
    cancel: "Cancel",
  },
} as const;