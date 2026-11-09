// URBA — POST /api/urbanisme
//
// Porte serveur d'URBA, ajoutée le 09/11/2026 pour MARTEAU. Elle rend,
// parcelle par parcelle, ce que la page d'URBA affiche déjà : document
// d'urbanisme opposable, zonage, informations (dont périmètres de zone
// d'aménagement concerté), servitudes d'utilité publique, prescriptions.
// Même source que la page : le Géoportail de l'urbanisme, lu par
// l'interface cartographique de l'IGN. AUCUNE donnée Sitadel ici : les
// permis de construire ne sont pas dans cette base.
//
// Entrée  : { parcelles: ["14715000AD0811", …] }   (identifiant cadastral
//           à 14 caractères : INSEE 5 + préfixe 3 + section 2 + numéro 4)
// Sortie  : { interroge_le, parcelles: { "<code>": { statut, … } } }
//           statut : ok | introuvable | erreur
//
// Limites voulues : 40 parcelles par appel, 3 parcelles traitées en même
// temps, 8 s par requête. Une parcelle en échec n'arrête pas les autres.

const APICARTO = 'https://apicarto.ign.fr/api';
const GPU = APICARTO + '/gpu';
const MAX_PARCELLES = 40;
const SIMULTANEES = 3;
const DELAI = 8000;

// Communes à arrondissements : le cadastre de l'IGN attend le code de la
// ville entière, l'arrondissement à part (constaté sur REDPAR, 10/2026).
function codesCadastre(insee) {
  if (/^751(0[1-9]|1\d|20)$/.test(insee)) return { code_insee: '75056', code_arr: insee.slice(2) };
  if (/^6938[1-9]$/.test(insee)) return { code_insee: '69123', code_arr: insee.slice(2) };
  if (/^132(0[1-9]|1[0-6])$/.test(insee)) return { code_insee: '13055', code_arr: insee.slice(2) };
  return { code_insee: insee };
}

async function jget(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DELAI);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Une couche du Géoportail : null si la requête a échoué (≠ tableau vide).
async function couche(nom, geom) {
  try {
    const fc = await jget(`${GPU}/${nom}?geom=${encodeURIComponent(JSON.stringify(geom))}`);
    return (fc && fc.features) || [];
  } catch (e) { return null; }
}

const cacheCommunes = new Map();
async function commune(insee) {
  if (!cacheCommunes.has(insee)) {
    cacheCommunes.set(insee, jget(`${GPU}/municipality?insee=${encodeURIComponent(insee)}`)
      .then((fc) => (fc.features && fc.features[0] ? fc.features[0].properties : null))
      .catch(() => null));
  }
  return cacheCommunes.get(insee);
}

const dateFr = (d) => {
  d = String(d || '');
  return /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : (d || null);
};
const propre = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const ZAC = /zone d.?am[ée]nagement concert|\bZAC\b/i;

async function traiterParcelle(code) {
  const insee = code.slice(0, 5), section = code.slice(8, 10), numero = code.slice(10, 14);
  if (!/^[0-9AB][0-9]{4}$/.test(insee) || !/^\d{4}$/.test(numero)) return { statut: 'erreur', raison: 'identifiant de parcelle illisible' };
  const q = new URLSearchParams({ ...codesCadastre(insee), section, numero });
  let parcelle;
  try {
    const fc = await jget(`${APICARTO}/cadastre/parcelle?${q}`);
    parcelle = fc.features && fc.features[0];
  } catch (e) { return { statut: 'erreur', raison: 'cadastre injoignable' }; }
  if (!parcelle) return { statut: 'introuvable' };

  const geom = parcelle.geometry;
  const [info, documents, zonesUrba, secteurs, infoSurf, supS, supL, supP, prescS] = await Promise.all([
    commune(insee),
    couche('document', geom), couche('zone-urba', geom), couche('secteur-cc', geom),
    couche('info-surf', geom),
    couche('assiette-sup-s', geom), couche('assiette-sup-l', geom), couche('assiette-sup-p', geom),
    couche('prescription-surf', geom),
  ]);
  // Les couches essentielles (document, zonage) en échec : la parcelle est
  // en erreur, on ne rend pas un « rien » qui serait faux.
  if (documents === null || zonesUrba === null) return { statut: 'erreur', raison: 'Géoportail de l\'urbanisme injoignable' };

  const p = parcelle.properties || {};
  const zones = [...zonesUrba, ...(secteurs || [])].map((f) => {
    const z = f.properties || {};
    return { libelle: propre(z.libelle || z.typesect || 'Secteur'), libelong: propre(z.libelong), typezone: propre(z.typezone) };
  });
  const infos = (infoSurf || []).map((f) => f.properties || {});
  // 09/11/2026 — une ZAC est reconnue par son CODE du standard CNIG
  // (INFORMATION 02-00, annexe obligatoire R151-52 8°) OU, à défaut, par
  // son libellé : certains plans anciens ou mal codés n'ont que le texte.
  const estZacCode = (x) => String(x.typeinf ?? '').padStart(2, '0') === '02';
  const zac = infos.filter((x) => estZacCode(x) || ZAC.test(propre(x.libelle) + ' ' + propre(x.txt)))
    .map((x) => propre(x.libelle || x.txt) || 'Zone d\u2019aménagement concerté');
  const sup = [...(supS || []), ...(supL || []), ...(supP || [])].map((f) => {
    const s = f.properties || {};
    return { categorie: propre(s.suptype).toUpperCase(), libelle: propre(s.nomass || s.typeass) };
  });

  return {
    statut: 'ok',
    commune: propre(p.nom_com || (info && info.name)),
    rnu: !!(info && info.is_rnu),
    documents: documents.map((f) => {
      const d = f.properties || {};
      return { type: propre(d.du_type), nom: propre(d.name || d.partition), approuve_le: dateFr(d.datappro) };
    }),
    zones,
    zac: [...new Set(zac)],
    informations: [...new Set(infos.map((x) => propre(x.libelle)).filter(Boolean))],
    servitudes: sup,
    prescriptions: [...new Set((prescS || []).map((f) => propre((f.properties || {}).libelle)).filter(Boolean))],
    partiel: [infoSurf, supS, supL, supP, secteurs].some((x) => x === null),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  let corps = req.body;
  if (typeof corps === 'string') { try { corps = JSON.parse(corps); } catch { corps = {}; } }
  const demandees = [...new Set((corps?.parcelles ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!demandees.length) return res.status(400).json({ erreur: 'parcelles requises' });

  const lot = demandees.slice(0, MAX_PARCELLES);
  const sortie = {};
  let i = 0;
  const ouvrier = async () => {
    while (i < lot.length) {
      const code = lot[i++];
      try { sortie[code] = await traiterParcelle(code); }
      catch (e) { sortie[code] = { statut: 'erreur', raison: e.message }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SIMULTANEES, lot.length) }, ouvrier));

  return res.status(200).json({
    interroge_le: new Date().toISOString(),
    source: "Géoportail de l'urbanisme (interface cartographique de l'IGN)",
    non_traitees: demandees.length - lot.length,
    parcelles: sortie,
  });
}
