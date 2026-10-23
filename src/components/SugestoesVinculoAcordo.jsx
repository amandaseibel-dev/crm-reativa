// Fila assistida: acordo sem vinculo -> evidencia Prime/portador 195 -> SUGESTAO -> a gestao ACEITA ou REJEITA.
// Nada aqui vincula sozinho. "Aceitar como origem" chama a RPC acordo_vinculo_sugestao_confirmar, que REVALIDA no servidor e so entao usa a
// RPC oficial vincular_titulos_acordo. "Rejeitar" grava a composicao rejeitada e nao altera nenhum objeto financeiro.
//
// O VOCABULARIO MUDOU EM 23/10/2026, e nao e cosmetica. O rotulo antigo
// ("Confirmar vinculo") prometia mais do que a regra entrega: a decisao da
// gestao de 12/09/2026 (docs/CLASSIFICACAO-VINCULO-ACORDO-MENSALIDADE.md) fixa o
// teto em ALTA_CONFIANCA e proibe CONFIRMADO, porque os dois lados do vinculo
// tem naturezas de prova diferentes -- a mensalidade e escolhida pelo boleto
// EXATO (prova), o acordo por proximidade de data numa janela de -60/+7
// (inferencia). Um vinculo nao pode ser mais forte que o seu lado mais fraco.
//
// VINCULO NAO E PAGAMENTO. Aceitar a origem nao quita, nao baixa e nao zera
// valor: em acordo ATIVO a mensalidade vira NEGOCIADO/vinculada e sai do saldo
// porque as PARCELAS do acordo entram no lugar. E por isso que o servidor passou
// a exigir acordo ATIVO e parcela viva -- sem parcela viva, a divida sairia da
// cobranca sem nada substituir.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import { cpfMascarado, dataBR } from "../utils/sugestoesVinculo";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const FILTROS = [
  { id: "FORTE", rotulo: "Alta confiança", ajuda: "um único grupo Prime 195 compatível, CPF e documentos conferem, títulos livres, nenhuma concorrência, acordo ATIVO e com parcela viva. É o teto da regra: alta confiança, nunca confirmação — o lado do acordo é inferência por data" },
  { id: "REVISAO", rotulo: "Revisão", ajuda: "há evidência Prime 195, mas com ambiguidade (vários grupos ou acordo concorrente): decida na ficha" },
  { id: "SEM_EVIDENCIA", rotulo: "Sem evidência", ajuda: "nenhum grupo Prime 195 plausível para este acordo" },
  { id: "REJEITADAS", rotulo: "Rejeitadas", ajuda: "composições que a gestão já rejeitou; só voltam se a evidência mudar" },
];
const MOTIVOS = {
  UNICO_GRUPO_195_COMPATIVEL: "Único grupo Prime 195 compatível, sem concorrência",
  MULTIPLOS_GRUPOS_195: "Mais de um grupo Prime 195 na janela do acordo",
  ACORDO_CONCORRENTE: "Outro acordo do mesmo aluno (mesmo cancelado) disputa o mesmo grupo",
  GRUPO_195_FORA_DA_JANELA: "Há liquidação no 195, mas fora da janela de −60/+7 dias do acordo",
  SEM_GRUPO_195: "Nenhuma liquidação Prime 195 compatível",
  ALUNO_SEM_CPF: "Aluno sem CPF: não dá para conferir o extrato",
  ACORDO_QUITADO_EXIGE_REVISAO: "Acordo fora de ATIVO: vincular quitaria a mensalidade, e quitação exige pagamento comprovado — só por revisão manual",
  ACORDO_SEM_PARCELA_VIVA: "Acordo ATIVO sem parcela viva: vincular tiraria a mensalidade do saldo sem nada entrar no lugar",
};
const ERROS = {
  SUGESTAO_MUDOU: "A evidência mudou desde que você abriu a fila. Nada foi vinculado; a lista foi atualizada.",
  SUGESTAO_NAO_E_FORTE: "Esta sugestão deixou de ser forte. Nada foi vinculado.",
  ACORDO_NAO_ELEGIVEL: "O acordo não está mais elegível. Nada foi vinculado.",
  VINCULO_RECUSADO: "A regra oficial de vínculo recusou a operação. Nada foi vinculado.",
  ACORDO_NAO_ATIVO_EXIGE_REVISAO: "Este acordo não está ATIVO. Vincular aqui quitaria a mensalidade, e quitação exige pagamento comprovado — o caminho é a revisão manual. Nada foi vinculado.",
  ACORDO_SEM_PARCELA_VIVA: "Este acordo não tem parcela viva. Vincular tiraria a mensalidade do saldo sem nada entrar no lugar. Nada foi vinculado.",
  ACORDO_ATIVO_SEM_PARCELA_VIVA: "Este acordo não tem parcela viva. Vincular tiraria a mensalidade do saldo sem nada entrar no lugar. Nada foi vinculado.",
};

export default function SugestoesVinculoAcordo({ onAbrirFicha, recarregar = 0 }) {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");
  const [filtro, setFiltro] = useState("FORTE");
  const [abertos, setAbertos] = useState({});
  const [rejeitando, setRejeitando] = useState(null); // { acordo_id, motivo }
  const [ocupado, setOcupado] = useState(null);
  const [ciclo, setCiclo] = useState(0);

  // Recarrega a fila (botao Atualizar, depois de confirmar/rejeitar, ou quando a ficha fecha). `limpar=false` preserva a mensagem da acao.
  function recarregar_(limpar = true) { if (limpar) setErro(""); setCarregando(true); setCiclo((c) => c + 1); }
  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error } = await supabase.rpc("acordos_vinculo_sugestoes");
      if (!vivo) return;
      if (error) setErro(error.message);
      setLinhas(data || []);
      setCarregando(false);
    })();
    return () => { vivo = false; };
  }, [ciclo, recarregar]);

  const grupos = useMemo(() => {
    const g = { FORTE: [], REVISAO: [], SEM_EVIDENCIA: [], REJEITADAS: [] };
    for (const l of linhas) { if (l.rejeitada) g.REJEITADAS.push(l); else (g[l.nivel] || g.SEM_EVIDENCIA).push(l); }
    return g;
  }, [linhas]);
  const visiveis = grupos[filtro] || [];

  async function confirmar(l) {
    const n = (l.titulos || []).length;
    if (!window.confirm(`Aceitar ${n} mensalidade(s) como origem do acordo ${l.numero_acordo || ""}?\n\nIsto NÃO quita e NÃO dá baixa: a mensalidade fica NEGOCIADA e sai do saldo porque as parcelas do acordo entram no lugar. O servidor revalida a evidência e usa a regra oficial de vínculo.`)) return;
    setOcupado(l.acordo_id); setMsg(""); setErro("");
    const { data, error } = await supabase.rpc("acordo_vinculo_sugestao_confirmar", { p_acordo_id: l.acordo_id, p_composicao_hash: l.composicao_hash });
    setOcupado(null);
    if (error) setErro(error.message);
    else if (data && data.ok) setMsg(`Origem aceita com alta confiança: ${(data.titulo_ids || []).length} mensalidade(s) negociada(s) no acordo ${l.numero_acordo || ""}. Nada foi quitado nem baixado.`);
    else setErro(ERROS[data && data.erro] || (data && data.erro) || "Não foi possível confirmar.");
    recarregar_(false);
  }
  async function rejeitar() {
    const l = linhas.find((x) => x.acordo_id === rejeitando.acordo_id);
    if (!l) { setRejeitando(null); return; }
    setOcupado(l.acordo_id); setMsg(""); setErro("");
    const { data, error } = await supabase.rpc("acordo_vinculo_sugestao_rejeitar", { p_acordo_id: l.acordo_id, p_composicao_hash: l.composicao_hash, p_motivo: rejeitando.motivo || null });
    setOcupado(null); setRejeitando(null);
    if (error) setErro(error.message);
    else if (data && data.ok) setMsg("Sugestão rejeitada. Ela só volta se a composição mudar.");
    else setErro(ERROS[data && data.erro] || (data && data.erro) || "Não foi possível rejeitar.");
    recarregar_(false);
  }

  return (
    <div data-testid="sugestoes-vinculo">
      <div style={S.barra}>
        {FILTROS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFiltro(f.id)} aria-pressed={filtro === f.id}
            style={{ ...S.btnGhostClaro, ...(filtro === f.id ? { background: "#1e40af", color: "#fff" } : null) }}>
            {f.rotulo} ({grupos[f.id].length})
          </button>
        ))}
        <button type="button" onClick={() => recarregar_()} style={S.btnGhost} disabled={carregando}>{carregando ? "Carregando…" : "Atualizar"}</button>
      </div>
      <p style={S.muted}>{FILTROS.find((f) => f.id === filtro)?.ajuda}</p>
      {erro ? <div style={S.erroBox}>{erro}</div> : null}
      {msg ? <div style={{ ...S.erroBox, background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", borderColor: "var(--rv-verde-ok-borda)" }}>{msg}</div> : null}
      {!carregando && visiveis.length === 0 ? <p style={S.muted}>Nada neste filtro.</p> : null}

      <div style={S.cards}>
        {visiveis.map((l) => {
          const forte = l.nivel === "FORTE";
          const aberto = !!abertos[l.acordo_id];
          const titulos = l.titulos || [];
          return (
            <div key={l.acordo_id} style={S.card} data-testid="sugestao-card">
              <div style={S.cardHead}>
                <div style={S.cardHeadInfo}>
                  <span style={S.cardNome}>{l.nome || "(sem nome)"}</span>
                  <span style={S.cardCpf}>{cpfMascarado(l.cpf)}</span>
                  {l.responsavel_email ? <span style={S.cardUnidade}>{l.responsavel_email}</span> : <span style={S.respVazio}>sem responsável</span>}
                </div>
                <div style={S.cardHeadDir}>
                  <span style={{ ...S.chip, ...(forte ? S.chipOk : l.nivel === "REVISAO" ? S.chipPend : S.chipZero) }}>
                    {forte ? "Alta confiança" : l.nivel === "REVISAO" ? "Revisão" : "Sem evidência"}
                  </span>
                  {l.rejeitada ? <span style={{ ...S.chip, ...S.chipRej }}>Rejeitada</span> : null}
                  <button type="button" style={S.btnFicha} onClick={() => onAbrirFicha && onAbrirFicha(l.aluno_id)}>Abrir ficha</button>
                </div>
              </div>
              <div style={S.cardResumo}>
                <table style={S.tabela}>
                  <thead><tr><th style={S.th}>Acordo</th><th style={S.th}>Status</th><th style={S.th}>Criado em</th><th style={S.thNum}>Valor</th><th style={S.th}>Liquidação Prime 195</th><th style={S.th}>Motivo</th></tr></thead>
                  <tbody><tr>
                    <td style={S.td}>{l.numero_acordo || "(sem número)"}</td>
                    <td style={S.td}>{l.status}</td>
                    <td style={S.td}>{dataBR(l.criado_em)}</td>
                    <td style={S.tdNum}>{moeda(l.valor_total)}</td>
                    <td style={S.td}>{dataBR(l.liquidacao_195)}</td>
                    <td style={S.td}>{MOTIVOS[l.motivo] || l.motivo}</td>
                  </tr></tbody>
                </table>
              </div>
              {titulos.length > 0 ? (
                <div style={{ padding: "8px 16px" }}>
                  <button type="button" style={S.btnMini} onClick={() => setAbertos((a) => ({ ...a, [l.acordo_id]: !a[l.acordo_id] }))}>
                    {aberto ? "Ocultar" : "Ver"} {titulos.length} mensalidade(s) sugerida(s)
                  </button>
                  {aberto ? (
                    <table style={S.tabela} data-testid="titulos-sugeridos">
                      <thead><tr><th style={S.th}>Documento</th><th style={S.th}>Vencimento</th><th style={S.thNum}>Valor</th><th style={S.th}>Liquidação 195</th></tr></thead>
                      <tbody>
                        {titulos.map((t) => (
                          <tr key={t.titulo_id}><td style={S.td}>{t.documento}</td><td style={S.td}>{dataBR(t.vencimento)}</td><td style={S.tdNum}>{moeda(t.valor)}</td><td style={S.td}>{dataBR(t.liquidacao_195)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </div>
              ) : null}
              {l.rejeitada ? (
                <p style={{ ...S.muted, padding: "0 16px 10px" }}>Rejeitada por {l.rejeitado_por} em {dataBR(l.rejeitado_em)}{l.motivo_rejeicao ? ` — ${l.motivo_rejeicao}` : ""}.</p>
              ) : null}
              {!l.rejeitada && l.composicao_hash ? (
                <div style={{ ...S.acoes, padding: "0 16px 12px" }}>
                  {forte ? <button type="button" style={{ ...S.btnConf, ...(ocupado === l.acordo_id ? S.btnBusy : null) }} disabled={ocupado === l.acordo_id} onClick={() => confirmar(l)}>Aceitar como origem</button> : null}
                  <button type="button" style={S.btnRej} disabled={ocupado === l.acordo_id} onClick={() => setRejeitando({ acordo_id: l.acordo_id, motivo: "" })}>Rejeitar sugestão</button>
                </div>
              ) : null}
              {rejeitando && rejeitando.acordo_id === l.acordo_id ? (
                <div style={{ padding: "0 16px 12px", display: "flex", gap: 8, alignItems: "center" }}>
                  <textarea style={S.vincTextarea} rows={2} placeholder="Motivo (opcional)" value={rejeitando.motivo} onChange={(e) => setRejeitando({ ...rejeitando, motivo: e.target.value })} />
                  <button type="button" style={S.btnRej} onClick={rejeitar}>Registrar rejeição</button>
                  <button type="button" style={S.btnGhostClaro} onClick={() => setRejeitando(null)}>Cancelar</button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
