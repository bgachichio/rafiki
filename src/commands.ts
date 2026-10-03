// The command menu Telegram shows under the "/" button. deploy.sh carries the same list; a test keeps them equal.
export const COMMANDS: { command: string; description: string }[] = [
  { command: "today", description: "Top three for today" }, { command: "rules", description: "How I remind you and work" }, { command: "memory", description: "See and change what I remember" },
  { command: "preferences", description: "See and change your preferences" }, { command: "skills", description: "Your skills files" }, { command: "model", description: "Choose the AI model" },
  { command: "agenda", description: "Today and tomorrow" }, { command: "calendars", description: "Choose which calendars I read" }, { command: "where", description: "Your last shared location" },
  { command: "place", description: "Name your last location" }, { command: "import", description: "Bring in memory and preferences from another AI" }, { command: "export", description: "Download everything I hold about you" },
  { command: "erase", description: "Wipe everything I hold (asks first)" }, { command: "limits", description: "What I cannot do" }, { command: "about", description: "Credits and support" },
  { command: "brief", description: "Your brief now" }, { command: "goals", description: "Your goals" }, { command: "ledger", description: "Customer ledger" }, { command: "money", description: "Spend summary" },
  { command: "fees", description: "Set your transaction fee tables" }, { command: "settings", description: "Brief time, quiet hours, budget" }, { command: "log", description: "What I did, and what it cost" },
  { command: "why", description: "Why I did my last thing" }, { command: "pause", description: "Stop me acting" }, { command: "resume", description: "Start me again" }, { command: "help", description: "What I can do" },
];
export const BOT_SHORT = "Your chief of staff, adviser, coach and business partner. It asks before it acts.";
export const BOT_DESCRIPTION = "Rafiki is a personal agent. Tell it what is slipping and what you are working toward. It reminds, drafts, plans and coaches, and it asks before it acts.\n\nMade with ❤️ by Brian Gachichio (x.com/b_gachichio). Open source: github.com/bgachichio/rafiki";
export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "poll_answer"];
