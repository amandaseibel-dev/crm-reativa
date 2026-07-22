import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function dataBR(v) { if (!v) return "-"; const p = String(v).slice(0, 10).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : v; }
function valTit(t) { return Number(t.valor_em_aberto != null ? t.valor_em_aberto : (t.saldo_corrigido != null ? t.saldo_corrigido : (t.valor_original || 0))); }

// Vincular mensalidades (titulos em aberto) ao acordo ativo do aluno.
// Parcela vinculada sai da carteira a cobrar (a exclusao ja acontece nos RPCs
// da carteira, que ignoram titulo com acordo_id preenchido).
export default function VincularMensalidadesAcordo({ alunoId }) {
  const [acordos, setAcordos] = useState([]);
  const [titulos, setTitulos] = useState([]);
  const [acordoSel, setAcordoSel] = useState("");
  const [sel, setSel] = useState({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  async function carregar() {
    if (!alunoId) { setCarregando(false); return; }
    setCarregando(true);
    const [{ data: acs }, { data: tits }] = await Promise.all([
      supabase.from("acordos").select("id, numero_acordo, valor_total, saldo, status, qtd_parcelas, criado_em").eq("aluno_id", alunoId).order("criado_em", { ascending: false }),
      supabase.from("acordos_titulos").select("id, competencia, vencimento, valor_em_aberto, valor_original, saldo_corrigido, situacao, status, acordo_id").eq("aluno_id", alunoId).or("and(situacao.eq.ABERTO,status.eq.vinculada),acordo_id.not.is.null").order("vencimento", { ascending: true }),
    ]);
    const lista = acs || [];
    setAcordos(lista);
    setTitulos(tits || []);
    const ativos = lista.filter((a) => a.status === "ATIVO");
    setAcordoSel((prev) => prev || (ativos[0] ? ativos[0].id : ""));
    setSel({});
    setCarregando(false);
  }
  useEffect(() => { carregar(); }, [alunoId]);

  const acordosAtivos = acordos.filter((a) => a.status === "ATIVO");
  const naoVinculados = titulos.filter((t) => !t.acordo_id);
  const vinculados = titulos.filter((t) => t.acordo_id);
  const idsSel = Object.keys(sel).filter((k) => sel[k]);

  async function vincular() {
    if (!acordoSel) { setMsg("Selecione o acordo."); return; }
    if (idsSel.length === 0) { setMsg("Selecione ao menos uma mensalidade."); return; }
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("vincular_titulos_acordo", { p_titulo_ids: idsSel, p_acordo_id: acordoSel });
    setSalvando(false);
    if (error || !data || !data.ok) { setMsg("Erro ao vincular: " + ((data && data.erro) || (error && error.message) || "")); return; }
    setMsg(data.vinculados + " parcela(s) vinculada(s) ao acordo — saíram da carteira a cobrar.");
    carregar();
  }
  async function desvincular(id) {
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("desvincular_titulos_acordo", { p_titulo_ids: [id] });
    setSalvando(false);
    if (error || !data || !data.ok) { setMsg("Erro ao desvincular."); return; }
    setMsg("Parcela desvinculada — voltou pra carteira a cobrar.");
    carregar();
  }

  if (carregando) return null;
  if (acordosAtivos.length === 0 && vinculados.length === 0) return null;

  return (
    <div style={S.card}>
      <h3 style={S.titulo}>🔗 Vincular mensalidades ao acordo</h3>
      <p style={S.sub}>Ligue as parcelas negociadas ao acordo ativo. Ao vincular, a parcela sai da carteira a cobrar (evita cobrança em dobro).</p>

      {acordosAtivos.length > 0 ? (
        <>
          <div style={S.linhaTopo}>
            <label style={S.label}>Acordo:</label>
            <select style={S.select} value={acordoSel} onChange={(e) => setAcordoSel(e.target.value)}>
              {acordosAtivos.map((a) => (
                <option key={a.id} value={a.id}>
                  Acordo #{a.numero_acordo || "-"} · {moeda(a.valor_total)} · {a.qtd_parcelas || "-"}x
                </option>
              ))}
            </select>
            <button style={{ ...S.btn, opacity: idsSel.length && !salvando ? 1 : 0.5 }} onClick={vincular} disabled={salvando || idsSel.length === 0}>
              {salvando ? "..." : "Vincular selecionadas (" + idsSel.length + ")"}
            </button>
          </div>

          {naoVinculados.length === 0 ? (
            <p style={S.vazio}>Nenhuma mensalidade em aberto para vincular.</p>
          ) : (
            <table style={S.tabela}>
              <thead><tr><th style={S.th}></th><th style={S.th}>Competência</th><th style={S.th}>Vencimento</th><th style={S.thNum}>Valor</th></tr></thead>
              <tbody>
                {naoVinculados.map((t) => (
                  <tr key={t.id}>
                    <td style={S.td}><input type="checkbox" checked={!!sel[t.id]} onChange={(e) => setSel((s) => ({ ...s, [t.id]: e.target.checked }))} /></td>
                    <td style={S.td}>{t.competencia || "-"}</td>
                    <td style={S.td}>{dataBR(t.vencimento)}</td>
                    <td style={S.tdNum}>{moeda(valTit(t))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p style={S.vazio}>Este aluno não tem acordo ativo — não há onde vincular.</p>
      )}

      {vinculados.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={S.subTit}>Parcelas já vinculadas ({vinculados.length})</div>
          <table style={S.tabela}>
            <thead><tr><th style={S.th}>Competência</th><th style={S.th}>Vencimento</th><th style={S.thNum}>Valor</th><th style={S.th}></th></tr></thead>
            <tbody>
              {vinculados.map((t) => (
                <tr key={t.id}>
                  <td style={S.td}>{t.competencia || "-"}</td>
                  <td style={S.td}>{dataBR(t.vencimento)}</td>
                  <td style={S.tdNum}>{moeda(valTit(t))}</td>
                  <td style={S.td}><button style={S.btnLink} onClick={() => desvincular(t.id)} disabled={salvando}>desvincular</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg ? <p style={S.msg}>{msg}</p> : null}
    </div>
  );
}

const S = {
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 14, padding: "16px 18px", margin: "16px 0" },
  titulo: { margin: "0 0 4px", fontSize: 15, fontWeight: 800, color: "#0f172a" },
  sub: { margin: "0 0 12px", fontSize: 12.5, color: "#64748b" },
  subTit: { fontSize: 12.5, fontWeight: 700, color: "#475569", marginBottom: 6 },
  linhaTopo: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  label: { fontSize: 13, fontWeight: 700, color: "#475569" },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 13, minWidth: 240 },
  btn: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnLink: { background: "transparent", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 8px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid #e6eaf0" },
  thNum: { textAlign: "right", padding: "6px 8px", color: "#8a93a3", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid #e6eaf0" },
  td: { padding: "7px 8px", borderBottom: "1px solid #f2f4f7", color: "#334155" },
  tdNum: { padding: "7px 8px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700, color: "#0f172a" },
  vazio: { fontSize: 13, color: "#94a3b8", margin: "6px 0" },
  msg: { fontSize: 13, color: "#166534", fontWeight: 600, marginTop: 10 },
};
