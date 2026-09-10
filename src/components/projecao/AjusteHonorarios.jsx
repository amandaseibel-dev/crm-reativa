import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";

// Honorario do pagamento: ver e corrigir.
//
// O honorario vem pronto no arquivo importado e ate 10/09/2026 nao havia como
// corrigir -- e ele e a base da comissao. Um digito errado no arquivo virava
// remuneracao errada para sempre.
//
// A lista abre pelos FORA DO PADRAO, que e o que precisa de decisao; o padrao
// (~7,3%) so aparece se pedirem. Ajustar exige motivo, fica na auditoria e
// recalcula a Projecao do mes na hora.
const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("pt-BR") : "—");
const mesAtual = () => new Date().toISOString().slice(0, 7);

// Cor por situacao: o olho precisa achar o problema antes de ler a tabela.
const SITUACAO = {
  ZERADO: { rotulo: "Zerado", cor: "#b91c1c", fundo: "rgba(185,28,28,0.14)" },
  ABAIXO: { rotulo: "Abaixo", cor: "#b45309", fundo: "rgba(180,83,9,0.14)" },
  ACIMA: { rotulo: "Acima", cor: "#1d4ed8", fundo: "rgba(29,78,216,0.14)" },
  PADRAO: { rotulo: "Padrão", cor: "#15803d", fundo: "rgba(21,128,61,0.12)" },
  SEM_BASE: { rotulo: "Sem base", cor: "#6b7280", fundo: "rgba(107,114,128,0.14)" },
};

export default function AjusteHonorarios() {
  const [mes, setMes] = useState(mesAtual());
  const [somenteFora, setSomenteFora] = useState(true);
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [editando, setEditando] = useState(null); // { pagamento_id, valor, motivo }
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async (m, fora) => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("projecao_honorarios_listar", {
      p_mes: m,
      p_somente_fora: fora,
    });
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar os honorários: " + (error.message || ""));
      return;
    }
    setLista(data || []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar(mes, somenteFora);
  }, [mes, somenteFora, carregar]);

  async function salvar() {
    if (!editando) return;
    const valor = Number(String(editando.valor).replace(",", "."));
    if (!Number.isFinite(valor) || valor < 0) {
      setAviso("Informe um valor de honorário válido.");
      return;
    }
    if (!editando.motivo?.trim()) {
      setAviso("O motivo é obrigatório — ele fica registrado na auditoria.");
      return;
    }
    setSalvando(true);
    setAviso("");
    const { error } = await supabase.rpc("projecao_alterar_honorario", {
      p_pagamento_id: editando.pagamento_id,
      p_novo_valor: valor,
      p_motivo: editando.motivo.trim(),
    });
    setSalvando(false);
    if (error) {
      setAviso("Não foi possível ajustar: " + (error.message || ""));
      return;
    }
    setAviso(`Honorário de ${editando.aluno_nome} ajustado para ${moeda(valor)}.`);
    setEditando(null);
    carregar(mes, somenteFora);
  }

  const totais = lista.reduce(
    (t, l) => ({
      pago: t.pago + Number(l.valor_pago || 0),
      hon: t.hon + Number(l.valor_honorario || 0),
    }),
    { pago: 0, hon: 0 }
  );
  const conta = (s) => lista.filter((l) => l.situacao === s).length;

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h3 style={S.titulo}>Honorários do mês</h3>
          <p style={S.sub}>
            O honorário vem do arquivo importado e é a base da comissão. Aqui você confere
            o percentual de cada pagamento e corrige o que veio errado.
          </p>
        </div>
        <div style={S.filtros}>
          <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} style={S.input} />
          <label style={S.check}>
            <input
              type="checkbox"
              checked={somenteFora}
              onChange={(e) => setSomenteFora(e.target.checked)}
            />
            Só fora do padrão
          </label>
          <button type="button" style={S.btnGhost} onClick={() => carregar(mes, somenteFora)}>
            Atualizar
          </button>
        </div>
      </div>

      {/* Placar: quantos problemas de cada tipo, antes da tabela. */}
      <div style={S.placar}>
        {["ZERADO", "ABAIXO", "ACIMA"].map((s) => (
          <div key={s} style={{ ...S.cartao, borderColor: SITUACAO[s].cor }}>
            <span style={{ ...S.cartaoNum, color: SITUACAO[s].cor }}>{conta(s)}</span>
            <span style={S.cartaoRot}>{SITUACAO[s].rotulo}</span>
          </div>
        ))}
        <div style={S.cartao}>
          <span style={S.cartaoNum}>{moeda(totais.hon)}</span>
          <span style={S.cartaoRot}>Honorário listado</span>
        </div>
        <div style={S.cartao}>
          <span style={S.cartaoNum}>{moeda(totais.pago)}</span>
          <span style={S.cartaoRot}>Recebido listado</span>
        </div>
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}
      {aviso ? <p style={S.aviso}>{aviso}</p> : null}

      {carregando ? (
        <p style={S.muted}>Carregando…</p>
      ) : !lista.length ? (
        <p style={S.muted}>
          {somenteFora
            ? "Nenhum honorário fora do padrão neste mês."
            : "Nenhum pagamento neste mês."}
        </p>
      ) : (
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Data</th>
              <th style={S.th}>Aluno</th>
              <th style={S.th}>Operador</th>
              <th style={S.thNum}>Recebido</th>
              <th style={S.thNum}>Honorário</th>
              <th style={S.thNum}>%</th>
              <th style={S.th}>Situação</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((l) => {
              const sit = SITUACAO[l.situacao] || SITUACAO.SEM_BASE;
              return (
                <tr key={l.pagamento_id}>
                  <td style={S.td}>{dia(l.data_pagamento)}</td>
                  <td style={S.td}>
                    {l.aluno_nome || "—"}
                    {l.ja_ajustado ? (
                      <span style={S.selo} title={`Ajustado por ${l.ajustado_por}`}>✏️ já ajustado</span>
                    ) : null}
                  </td>
                  <td style={S.td}>{l.operador_nome || "—"}</td>
                  <td style={S.tdNum}>{moeda(l.valor_pago)}</td>
                  <td style={S.tdNum}>{moeda(l.valor_honorario)}</td>
                  <td style={{ ...S.tdNum, color: sit.cor, fontWeight: 800 }}>
                    {l.percentual == null ? "—" : `${Number(l.percentual).toFixed(2)}%`}
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.chip, color: sit.cor, background: sit.fundo }}>{sit.rotulo}</span>
                  </td>
                  <td style={S.td}>
                    <button
                      type="button"
                      style={S.btnAjustar}
                      onClick={() =>
                        setEditando({
                          pagamento_id: l.pagamento_id,
                          aluno_nome: l.aluno_nome,
                          valor_pago: l.valor_pago,
                          atual: l.valor_honorario,
                          // Sugere o padrao de 7,3% do recebido, arredondado.
                          valor: (Number(l.valor_pago || 0) * 0.073).toFixed(2),
                          motivo: "",
                        })
                      }
                    >
                      Ajustar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editando ? (
        <div style={S.overlay} onClick={() => setEditando(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h4 style={S.modalTit}>Ajustar honorário</h4>
            <p style={S.modalSub}>
              {editando.aluno_nome} · recebido {moeda(editando.valor_pago)} · honorário atual{" "}
              {moeda(editando.atual)}
            </p>
            <label style={S.label}>Novo honorário (R$)</label>
            <input
              style={S.input}
              value={editando.valor}
              onChange={(e) => setEditando({ ...editando, valor: e.target.value })}
              inputMode="decimal"
            />
            <label style={S.label}>Motivo (fica registrado)</label>
            <textarea
              style={{ ...S.input, minHeight: 64, resize: "vertical", fontFamily: "inherit" }}
              value={editando.motivo}
              onChange={(e) => setEditando({ ...editando, motivo: e.target.value })}
              placeholder="Ex.: honorário veio zerado no arquivo do banco"
            />
            <div style={S.modalAcoes}>
              <button type="button" style={S.btnGhost} onClick={() => setEditando(null)}>
                Cancelar
              </button>
              <button
                type="button"
                style={salvando ? { ...S.btnSalvar, opacity: 0.5 } : S.btnSalvar}
                disabled={salvando}
                onClick={salvar}
              >
                {salvando ? "Salvando…" : "Salvar ajuste"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const S = {
  wrap: { padding: "18px 4px" },
  topo: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  titulo: { margin: 0, fontSize: 17, fontWeight: 800, color: "var(--rv-tinta)" },
  sub: { margin: "4px 0 0", fontSize: 13, color: "var(--rv-texto-suave)", maxWidth: 620 },
  filtros: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "8px 11px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)", width: "100%", boxSizing: "border-box" },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--rv-texto-suave)", whiteSpace: "nowrap" },
  btnGhost: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  placar: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 },
  cartao: { border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 16px", background: "var(--rv-superficie)", display: "flex", flexDirection: "column", minWidth: 120 },
  cartaoNum: { fontSize: 18, fontWeight: 800, color: "var(--rv-tinta)" },
  cartaoRot: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", fontWeight: 700 },
  muted: { color: "var(--rv-texto-suave)", fontSize: 14 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, fontWeight: 600 },
  aviso: { color: "var(--rv-verde-ok-texto)", fontSize: 13, fontWeight: 600 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "var(--rv-superficie)", borderRadius: 10, overflow: "hidden" },
  th: { textAlign: "left", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)" },
  thNum: { textAlign: "right", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)" },
  td: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)" },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700, color: "var(--rv-tinta)" },
  chip: { fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" },
  selo: { marginLeft: 8, fontSize: 11, color: "var(--rv-texto-fraco)" },
  btnAjustar: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 },
  modal: { background: "var(--rv-superficie)", borderRadius: 14, padding: 20, width: "min(460px, 96vw)", display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  modalTit: { margin: 0, fontSize: 16, fontWeight: 800, color: "var(--rv-tinta)" },
  modalSub: { margin: "0 0 6px", fontSize: 13, color: "var(--rv-texto-suave)" },
  label: { fontSize: 12, fontWeight: 700, color: "var(--rv-texto-forte)", marginTop: 4 },
  modalAcoes: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 },
  btnSalvar: { background: "#15803d", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
};
