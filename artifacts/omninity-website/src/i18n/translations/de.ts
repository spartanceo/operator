/**
 * German (DE) translation bundle.
 *
 * Initial machine-drafted translation per Task #28. Awaiting human review
 * before launch. Mirror the shape of `en.ts` exactly.
 */

import type { TranslationShape } from "./en";

export const de: TranslationShape = {
  common: {
    appName: "Omninity Operator",
    download: "OP herunterladen",
    learnMore: "Mehr erfahren",
    loading: "Wird geladen…",
    close: "Schließen",
    cancel: "Abbrechen",
  },
  nav: {
    product: "Produkt",
    marketplace: "Marktplatz",
    pricing: "Preise",
    creators: "Creator",
    docs: "Dokumentation",
    openMenu: "Menü öffnen",
    navigation: "Navigation",
  },
  footer: {
    columns: {
      product: "Produkt",
      resources: "Ressourcen",
      creators: "Creator",
      company: "Unternehmen",
      legal: "Rechtliches",
    },
    links: {
      whatItDoes: "Was es kann",
      download: "Herunterladen",
      pricing: "Preise",
      skillMarketplace: "Skill-Marktplatz",
      releaseNotes: "Versionshinweise",
      documentation: "Dokumentation",
      skillSdk: "Skill-SDK",
      apiReference: "API-Referenz",
      troubleshooting: "Fehlerbehebung",
      becomeCreator: "Creator werden",
      marketplacePolicy: "Marktplatz-Richtlinien",
      revenueShare: "Umsatzbeteiligung",
      featuredSkills: "Vorgestellte Skills",
      about: "Über uns",
      manifesto: "Manifest",
      pressKit: "Presse-Kit",
      contact: "Kontakt",
      privacy: "Datenschutz",
      terms: "AGB",
      eula: "Endnutzer-Lizenzvertrag",
      euAiAct: "EU-KI-Verordnung",
      openSourceLicences: "Open-Source-Lizenzen",
    },
    tagline:
      "Für Menschen gemacht, die ihre Werkzeuge zurückwollen. Lokal zuerst, standardmäßig umkehrbar, loyal zur Person an der Tastatur.",
    copyright:
      "© {{year}} Omninity, PBC. Die private Betriebsebene für deinen Computer.",
    statusQuiet: "Alle Systeme sind ruhig.",
    socials: {
      github: "GitHub",
      twitter: "Twitter",
      discord: "Discord",
      rss: "RSS",
    },
  },
  a11y: {
    skipToContent: "Zum Hauptinhalt springen",
    languageSelector: "Sprache auswählen",
    currentLanguage: "Aktuelle Sprache: {{language}}",
    openLanguageMenu: "Sprache ändern",
  },
  settings: {
    title: "Einstellungen",
    description: "Konfiguriere Laufzeit, Modelle und Workspace-Identität.",
    save: "Speichern",
    reset: "Zurücksetzen",
    loading: "Wird geladen…",
    appearance: {
      title: "Erscheinungsbild",
      description: "Wechsle zwischen hellem und dunklem Thema. Bleibt zwischen Sitzungen erhalten.",
      darkMode: "Dunkler Modus",
      currently: "Aktuell: {{theme}}",
    },
    language: {
      title: "Sprache",
      description:
        "Wähle die Sprache für die gesamte Operator-Oberfläche. Die Änderung wird sofort angewendet — kein Neustart erforderlich.",
      label: "Oberflächensprache",
    },
    runtime: {
      title: "Laufzeit",
      description: "Ollama-Endpunkt und Standardmodell, das von Agenten verwendet wird.",
      ollamaUrl: "Ollama-URL",
      defaultModel: "Standardmodell",
      cloudMode: "Cloud-Modus",
      cloudModeDescription:
        "Erlaube den Rückgriff auf ein gehostetes Modell, wenn das lokale nicht verfügbar ist.",
    },
    workspace: {
      title: "Workspace",
      description:
        "Mandanten-Identität, die bei jeder API-Anfrage gesendet wird, und der lokale Dateisystempfad, den die Datei-Tools berühren dürfen.",
      tenantId: "Mandanten-ID",
      workspaceId: "Workspace-ID",
      workspacePath: "Workspace-Pfad",
    },
    pull: {
      title: "Benutzerdefiniertes Modell laden",
      description:
        "Alle lokalen Modelle, die Ollama meldet, plus ein manueller Pull für Modelle außerhalb des kuratierten Katalogs (fortgeschritten).",
      installed: "Lokal installiert",
      noModels: "Keine Modelle gemeldet.",
      label: "Modell nach Name laden",
      placeholder: "z. B. llama3.1:8b",
      action: "Laden",
      actionPending: "Wird geladen…",
      queued: "Pull in Warteschlange: {{name}} ({{status}})",
    },
    account: {
      title: "Konto",
      description: "Informationen, die von GET /api/auth/me zurückgegeben werden.",
      notSignedIn:
        "Nicht angemeldet. Die Authentifizierung kommt in einem späteren Meilenstein — vorerst wird der Mandanten-Header verwendet.",
    },
  },
};
