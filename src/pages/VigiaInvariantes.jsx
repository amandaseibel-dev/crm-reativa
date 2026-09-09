// O VIGIA DE INVARIANTES — a tela que mostra o que o sistema não deveria deixar
// acontecer, e quantas vezes está acontecendo agora.
//
// POR QUE EXISTE: em 08 e 09/09/2026 encontramos, um a um e a mão, um cron
// caído havia 96 horas, 219 fichas cobrando com o nome de outra pessoa, 1.150
// títulos cobrados depois de o Prime registrar o pagamento e 34 fichas fantasma
// segurando R$ 89.988,24. Nenhum apareceu por alarme — todos por alguém
// tropeçar. Cada checagem aqui é um desses achados virado rotina diária.
//
// O VIGIA NÃO CORRIGE NADA. Ele conta e registra. Toda correção automática que
// este sistema já tentou (baixa pelo Prime, exclusão por título repetido) teria
// destruído dinheiro legítimo. Ele aponta; gente decide.
//
// PARA QUEM: gestão. `invariantes_painel()` devolve zero linha para quem não é
// gestão — a regra mora no banco, não aqui.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE = "'Sora','Inter',system-ui,sans-serif";
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");

// Tokens do CRM (src/index.css). O fundo do selo vem de color-mix sobre a
// propria cor de estado, para nao inventar hex novo e continuar valendo se o
// tema mudar.
const CORES = {
  GRAVE: { fundo: "color-mix(in srgb, var(--rv-erro) 12%, transparent)", texto: "var(--rv-erro)", borda: "var(--rv-erro)" },
  ATENCAO: { fundo: "color-mix(in srgb, var(--rv-alerta) 14%, transparent)", texto: "var(--rv-alerta)", borda: "var(--rv-alerta)" },
  INFO: { fundo: "var(--rv-borda-suave)", texto: "var(--rv-texto-suave)", borda: "var(--rv-borda)" },
};
const ROTULO = { GRAVE: "Grave", ATENCAO: "Atenção", INFO: "Informativo" };

// Duas checagens contam tempo, não ocorrências. Sem isso a tela diria
// "1.234 achados" para uma matview parada há 20 horas.
const UNIDADE = { matview_saude_velha: "min", bordero_atrasado: "dias" };

const quando = (v) => (v ? new Date(v).toLocaleString("pt-BR") : "—");

export default function VigiaInvariantes() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState("");

  // O estado ja nasce "carregando" e so muda dentro do .then — nenhum setState
  // sincrono no corpo do efeito, que dispararia renders em cascata. O guarda
  // `vivo` evita escrever em componente ja desmontado, como nas outras telas.
  function aplicar({ data, error }) {
    if (error) setErro(error.message);
    else { setErro(""); setLinhas(data || []); }
    setCarregando(false);
  }

  useEffect(() => {
    let vivo = true;
    supabase.rpc("invariantes_painel").then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, []);

  // Rodar à mão é leitura pura (~2 s medidos), então pode ficar na tela.
  // `invariantes_rodar` continua sem grant para authenticated; a tela passa pela
  // porta estreita `invariantes_conferir_agora`, que exige gestão no banco.
  async function rodarAgora() {
    setRodando(true);
    setErro("");
    const { error } = await supabase.rpc("invariantes_conferir_agora");
    if (error) {
      setErro(error.message);
    } else {
      aplicar(await supabase.rpc("invariantes_painel"));
    }
    setRodando(false);
  }

  const comAchado = linhas.filter((l) => Number(l.achados) > 0);
  const graves = comAchado.filter((l) => l.severidade === "GRAVE");
  const ultima = linhas.map((l) => l.rodado_em).filter(Boolean).sort().slice(-1)[0];

  return (
    <div style={{ padding: 24, fontFamily: FONTE, color: "var(--rv-texto)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Vigia de invariantes</h1>
        <span style={{ color: "var(--rv-texto-suave)", fontSize: 13 }}>
          {ultima ? `última rodada ${quando(ultima)}` : "nunca rodou"} · roda sozinho às 06:10
        </span>
        <button
          onClick={rodarAgora}
          disabled={rodando || carregando}
          style={{
            marginLeft: "auto", padding: "8px 14px", borderRadius: 8,
            border: "1px solid var(--rv-borda)", background: "var(--rv-fundo)",
            color: "var(--rv-texto)", cursor: rodando ? "wait" : "pointer", fontFamily: FONTE,
          }}
        >
          {rodando ? "Conferindo…" : "Conferir agora"}
        </button>
      </div>

      <p style={{ color: "var(--rv-texto-suave)", fontSize: 13, maxWidth: 760, lineHeight: 1.55 }}>
        Cada linha é uma coisa que o sistema não deveria deixar acontecer. O vigia
        confere todo dia e <strong>não corrige nada</strong> — ele conta e registra,
        porque toda correção automática que já tentamos aqui apagaria dinheiro legítimo.
      </p>

      {erro && (
        <div style={{ padding: 12, borderRadius: 8, background: "color-mix(in srgb, var(--rv-erro) 12%, transparent)", color: "var(--rv-erro)", marginBottom: 16 }}>
          {erro}
        </div>
      )}

      {!carregando && (
        <div style={{ marginBottom: 20, fontSize: 14, color: "var(--rv-texto-suave)" }}>
          {comAchado.length === 0
            ? "Nenhuma checagem apontando nada agora."
            : `${comAchado.length} de ${linhas.length} checagens apontando algo — ${graves.length} grave${graves.length === 1 ? "" : "s"}.`}
        </div>
      )}

      {carregando && <div style={{ color: "var(--rv-texto-suave)" }}>Carregando…</div>}

      <div style={{ display: "grid", gap: 12 }}>
        {linhas.map((l) => {
          const n = Number(l.achados);
          const cor = n > 0 ? CORES[l.severidade] || CORES.INFO : CORES.INFO;
          const unidade = UNIDADE[l.nome];
          const jobs = l.nome === "cron_com_falha" && Array.isArray(l.detalhe) ? l.detalhe : null;
          return (
            <div
              key={l.nome}
              style={{
                border: `1px solid ${n > 0 ? cor.borda : "var(--rv-borda)"}`,
                borderLeftWidth: 4,
                borderRadius: 10,
                padding: "14px 16px",
                background: "var(--rv-superficie)",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 12,
                alignItems: "start",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 15 }}>{l.titulo}</strong>
                  <span style={{
                    fontSize: 11, padding: "2px 8px", borderRadius: 99,
                    background: cor.fundo, color: cor.texto, textTransform: "uppercase", letterSpacing: 0.4,
                  }}>
                    {ROTULO[l.severidade] || l.severidade}
                  </span>
                  {!l.ligado && <span style={{ fontSize: 11, color: "var(--rv-texto-suave)" }}>desligada</span>}
                </div>
                <div style={{ fontSize: 13, color: "var(--rv-texto-suave)", marginTop: 4, lineHeight: 1.5 }}>
                  {l.explicacao}
                </div>
                {jobs && jobs.length > 0 && (
                  <div style={{ fontSize: 12, color: cor.texto, marginTop: 6 }}>
                    Rotinas que falharam: {jobs.join(", ")}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--rv-texto-suave)", marginTop: 6 }}>
                  Em 09/09: {l.base_09_09 || "—"}
                  {l.variacao != null && Number(l.variacao) !== 0 && (
                    <> · desde a rodada anterior: {Number(l.variacao) > 0 ? "+" : ""}{num(l.variacao)}</>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right", minWidth: 130 }}>
                <div style={{
                  fontSize: 26, fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  color: n > 0 ? cor.texto : "var(--rv-texto-suave)",
                }}>
                  {num(n)}{unidade ? <span style={{ fontSize: 13, fontWeight: 400 }}> {unidade}</span> : null}
                </div>
                {l.valor != null && (
                  <div style={{ fontSize: 13, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" }}>
                    {moeda(l.valor)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
