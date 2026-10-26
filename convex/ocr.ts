import { action } from "./_generated/server"
import { v } from "convex/values"
import { callMacalyJson } from "./macaly"

const SYSTEM_PROMPT = `Si presný OCR systém na čítanie slovenských úradných dokladov.
Dostaneš fotografiu alebo sken Osvedčenia o evidencii vozidla (OSV) vydaného na Slovensku,
buď časť I (identifikácia vozidla a údaje o majiteľovi a držiteľovi) alebo časť II
(technické údaje a charakteristika vozidla, prípadne záznamy o zmenách).

Úloha:
1. Prečítaj všetok text na doklade vrátane pečiatok, poznámok a ručne vpísaných údajov.
2. Urč, či ide o časť I alebo časť II (alebo iný typ dokladu).
3. Vyčleň všetky údaje vo forme dvojíc "názov údaju" a "hodnota" tak, ako sú uvedené na doklade.
   Vzorec osvedčenia má oficiálne číslované pozície. Ak je pole na doklade označené
   kódom pozície, použi v názve údaju tento kód aj názov poľa, vrátane diakritiky.
   Časť I - základné údaje o evidencii: A evidenčné číslo, B dátum prvej evidencie vozidla
   (rok výroby), E VIN, H platnosť do, I dátum prvej evidencie v SR, C.1.1 držiteľ osvedčenia,
   C.1.3 trvalý pobyt/sídlo držiteľa, C.2.1 vlastník vozidla, C.2.3 trvalý pobyt/sídlo vlastníka,
   ako aj zmeny údajov a záznamy o prevode držby.
   Časť II - zadná strana (technické údaje): 1 Druh, 2 J Kategória, 3 E VIN, 4 D.1 Značka,
   5 D.3 Obchodné názvy, 6-8 D.2 Typ/variant/verzia, 9 Výrobca vozidla, 10 K číslo typového
   schválenia, 11 dátum typového schválenia, 12 výrobca motora, 13 P.5 identifikačné číslo
   motora, 14 F.2 zdvíhový objem valcov, 15 katalyzátor, 16-17 P.2/P.4 najväčší výkon
   motora, 18 P.3 druh paliva, 19 Q výkon/hmotnosť, 20 prevodovka/počet stupňov,
   21 Druh (typ) karosérie, 22 R farba, 23 výrobca karosérie, 24 výrobné číslo,
   25.1 S.1 počet miest na sedenie, 25.2 S.2 počet miest na státie, 25.3 počet ložok,
   26 zaťaženie strechy, 27 objem skrine-cisterny, 28 W objem palivovej nádrže,
   29 rozmer rozvory, 30 rozmery ložnej plochy, 31 G prevádzková hmotnosť,
   32 F.1 najväčšia technicky prípustná celková hmotnosť, 33 N hmotnosť prípojného
   vozidla, 34 F.3 hmotnosť jazdnej súpravy, 35 hmotnosť prípojného vozidla (O.1 brzdené,
   O.2 nebrzdené), 36-37 brzdy, 38 druh kolies, 39 počet náprav, 40 M rozvor,
   41 rozmer a druh pneumatík, 42 rozmer ráfíkov, 43 T najväčšia konštrukčná rýchlosť,
   44 spaľovacie zariadenie, 46.1-3 najväčšie technicky prípustné hmotnosti v bode spojenia,
   47 emisie zvuku, 48 hladina vonkajšieho zvuku, 49 V.9 emisie BÚEHK, 50 dymivost,
   51.1-51.8 V.2/V.3/V.4/V.5/V.6/V.7/V.8 emisie CO, HC, NOx, častice, koef. absorpcie,
   CO2 a spotreba paliva.
   Vlastné názvy polí z dokladu majú prednosť pred zoznamom vyššie.
   Zakladaj len na tom, čo je na obrázku vidieť. Nič nevymýšľaj.
   Ak je hodnota nečitateľná alebo pole prázdne, uveď "(nevyplnené)".
   Ak je časť dokladu zamaľovaná tmavou plochou (anonymizovaná osobná oblasť),
   uveď v hodnote "(anonymizované)".
4. Ku každému údaju pridaj "part" označujúci, z ktorej časti dokladu pochádza:
   "časť I", "časť II" alebo "neuvedené".
5. Ku každému údaju pridaj "istotu": "výborná", "dobrá" alebo "nízka" podľa čitateľnosti.

Odpovedz IBA platným JSON objektom, bez markdownu a bez akéhokoľvek iného textu, v tvare:
{
  "documentType": "typ dokladu (napr. Osvedčenie o evidencii vozidla - časť I)",
  "fields": [{ "label": "názov údaju", "value": "hodnota", "part": "časť I", "certainty": "výborná" }],
  "notes": "krátka poznámka o stave dokladu, pečiatkach alebo nečitateľných častiach (alebo prázdny reťazec)"
}`

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

export const ocrDocument = action({
  args: {
    imageBase64: v.string(),
    mediaType: v.string(),
  },
  returns: v.object({
    documentType: v.string(),
    fields: v.array(
      v.object({
        label: v.string(),
        value: v.string(),
        part: v.string(),
        certainty: v.string(),
      }),
    ),
    notes: v.string(),
    rawText: v.string(),
  }),
  handler: async (_ctx, args) => {
    const response = await callMacalyJson("/api/client-app/llm-usage", {
      preset: "DOCS",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Prečítaj toto osvedčenie o evidencii vozidla a vyčleň z neho údaje." },
            { type: "image", image: args.imageBase64, mediaType: args.mediaType },
          ],
        },
      ],
    })

    const text = typeof response.text === "string" ? response.text.trim() : ""
    if (!text) {
      throw new Error("Služba OCR nevrátila žiadnu odpoveď. Skúste znova.")
    }

    const parsed = extractJson(text)
    const rawFields = Array.isArray(parsed?.fields) ? parsed!.fields : []
    const fields = rawFields
      .filter(
        (item): item is { label: string; value: string; part?: string; certainty?: string } =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { label?: unknown }).label === "string" &&
          typeof (item as { value?: unknown }).value === "string",
      )
      .map((item) => ({
        label: item.label,
        value: item.value,
        part:
          typeof item.part === "string" && item.part ? item.part : "neuvedené",
        certainty:
          typeof item.certainty === "string" && item.certainty
            ? item.certainty
            : "dobrá",
      }))

    return {
      documentType:
        typeof parsed?.documentType === "string" && parsed.documentType
          ? parsed.documentType
          : parsed
            ? "Neurčený typ dokladu"
            : "Odpoveď sa nepodarilo spracovať",
      fields,
      notes:
        typeof parsed?.notes === "string"
          ? parsed.notes
          : parsed
            ? ""
            : "Model nevrátil štruktúrovaný výstup, nižšie je nespracovaný text.",
      rawText: parsed ? "" : text,
    }
  },
})
