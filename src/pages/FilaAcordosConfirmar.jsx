import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "./Aluno";

// Fila de acordos importados para a operacao confirmar/acompanhar.
// A tela agrupa por CPF: 1 card por aluno, com uma tabela de todos os acordos dele.
// As acoes continuam individualizadas por ID do acordo.

const PAGE_SIZE = 1000;

function moeda(n) { return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

// CPF somente numeros, completado para 11 digitos (mantem os 11 finais se vier maior).
function normCpf(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 11 ? d.slice(-11) : d.padStart(11, "0");
}

function formatCpf(v) {
  const d = normCpf(v);
  if (d.length !== 11) return v || "-";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

const STATUS_META = {
  A_CONFIRMAR: { rotulo: "A confirmar", estilo: "chipPend" },
  CONFIRMADO: { rotulo: "Confirmado", estilo: "chipOk" },
  REJEITADO: { rotulo: "Rejeitado", estilo: "chipRej" },
};

// Responsável ESPECÍFICO do acordo. Prioriza o nome; usa o e-mail como fallback.
// Nunca herda o responsável do aluno/carteira: se ambos vierem vazios (a RPC só
// resolve quando ha vinculo seguro e unico com public.acordos), mostra "Sem responsavel".
function responsavelAcordo(resp) {
  const nome = String(resp?.operador_responsavel_nome || "").trim();
  if (nome) return nome;
  const email = String(resp?.operador_responsavel_email || "").trim();
  if (email) return email;
  return "Sem responsável";
}

export default function FilaAcordosConfirmar() {
  const [itens, setItens] = useState([]);
  const [responsaveis, setResponsaveis] = useState({}); // fila_id -> { nome, email }
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("A_CONFIRMAR");
  const [busca, setBusca] = useState("");
  const [email, setEmail] = useState("");
  const [fichaId, setFichaId] = useState(null);
  const [processando, setProcessando] = useState({}); // id do acordo -> true enquanto salva

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setEmail(data?.user?.email || "");
      carregar();
    })();
  }, []);

  // Busca TODOS os registros paginando por range ate acabar (evita o teto de 1000).
  async function carregar() {
    setCarregando(true);
    setErro("");
    let from = 0;
    const todos = [];
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("fila_acordos_confirmar")
          .select("*")
          .order("valor_total", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const lote = data || [];
        todos.push(...lote);
        if (lote.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      setItens(todos);
      // Resolve o responsavel ESPECIFICO de cada acordo (somente leitura).
      // A RPC devolve nome/email apenas quando ha vinculo unico e seguro com
      // public.acordos; caso contrario os campos vem nulos -> "Sem responsavel".
      // Falha aqui nao quebra a fila: apenas nao exibe responsavel.
      try {
        const { data: resp, error: respErr } = await supabase.rpc("fila_acordos_responsavel");
        if (respErr) throw respErr;
        const mapa = {};
        for (const r of resp || []) {
          mapa[r.fila_id] = {
            operador_responsavel_nome: r.operador_responsavel_nome,
            operador_responsavel_email: r.operador_responsavel_email,
          };
        }
        setResponsaveis(mapa);
      } catch {
        setResponsaveis({});
      }
    } catch (e) {
      setErro(e?.message || String(e));
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }

  // Troca o status de UM acordo, identificado SEMPRE pelo id unico (PK) da fila.
  // Nunca por aluno_id/CPF/matricula/card agrupado/indice: acao afeta 1 registro.
  // Estado de processamento e atualizacao sao individuais por id; try/catch/finally
  // garantem que a tela seja sempre liberada, mesmo se a requisicao falhar.
  async function mudarStatus(item, novoStatus) {
    if (!item?.id) return;
    if (processando[item.id]) return; // impede requisicao duplicada enquanto processa
    setProcessando((p) => ({ ...p, [item.id]: true }));
    setErro("");

    const patch = { status_confirmacao: novoStatus };
    if (novoStatus === "CONFIRMADO") {
      patch.operador_email = email;
      patch.confirmado_em = new Date().toISOString();
    } else if (novoStatus === "REJEITADO") {
      patch.operador_email = email;
      patch.confirmado_em = null;
    } else {
      // A_CONFIRMAR (reabrir)
      patch.confirmado_em = null;
    }

    try {
      const { error } = await supabase
        .from("fila_acordos_confirmar")
        .update(patch)
        .eq("id", item.id); // <- exatamente 1 registro, pelo id unico

      if (error) throw error;

      // Atualizacao otimista: mexe SOMENTE no acordo processado.
      // Outros acordos do mesmo aluno permanecem inalterados e visiveis.
      setItens((prev) => prev.map((x) => (x.id === item.id ? { ...x, ...patch } : x)));
    } catch (e) {
      // Mostra o erro real do Supabase.
      setErro(`Erro ao atualizar o acordo ${item.id}: ${e?.message || String(e)}`);
    } finally {
      // Libera SEMPRE o botao clicado, mesmo em caso de falha (evita travar a tela).
      setProcessando((p) => {
        const n = { ...p };
        delete n[item.id];
        return n;
      });
    }
  }

  const confirmar = (item) => mudarStatus(item, "CONFIRMADO");
  const rejeitar = (item) => mudarStatus(item, "REJEITADO");
  const reabrir = (item) => mudarStatus(item, "A_CONFIRMAR");

  // Filtro por status (client-side) + busca por nome/CPF.
  const filtrados = itens.filter((i) => {
    const st = i.status_confirmacao || "A_CONFIRMAR";
    if (filtro !== "TODOS" && st !== filtro) return false;
    if (!busca.trim()) return true;
    const t = busca.trim().toLowerCase();
    const cpfBusca = t.replace(/\D/g, "");
    const nomeOk = String(i.nome || "").toLowerCase().includes(t);
    const cpfOk = cpfBusca && normCpf(i.cpf).includes(cpfBusca);
    return nomeOk || cpfOk;
  });

  // Agrupa por CPF -> 1 card por aluno.
  const grupos = (() => {
    const map = new Map();
    for (const i of filtrados) {
      const cpf = normCpf(i.cpf);
      const chave = cpf || `SEMCPF-${i.id}`;
      if (!map.has(chave)) {
        map.set(chave, { chave, cpf, nome: i.nome, unidade: i.unidade, alunoId: i.aluno_id, acordos: [] });
      }
      map.get(chave).acordos.push(i);
    }
    const arr = Array.from(map.values());
    arr.forEach((g) => { g.total = g.acordos.reduce((s, a) => s + (Number(a.valor_total) || 0), 0); });
    arr.sort((a, b) => b.total - a.total);
    return arr;
  })();

  const totalAlunos = grupos.length;
  const totalAcordos = filtrados.length;
  const totalValor = filtrados.reduce((s, i) => s + (Number(i.valor_total) || 0), 0);

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Fila de confirmação de acordos</h1>
          <p style={S.sub}>Acordos importados para a operação confirmar com o aluno e acompanhar.</p>
        </div>
        <button type="button" style={S.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      <div style={S.barra}>
        <select style={S.select} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
          <option value="A_CONFIRMAR">A confirmar</option>
          <option value="CONFIRMADO">Confirmados</option>
          <option value="REJEITADO">Rejeitados</option>
          <option value="TODOS">Todos</option>
        </select>
        <input style={S.input} placeholder="Buscar por nome ou CPF..." value={busca} onChange={(e) => setBusca(e.target.value)} />
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{totalAlunos} alunos</span>
          <span style={S.contadorAcordos}>{totalAcordos} acordos</span>
          <span style={S.contadorValor}>{moeda(totalValor)}</span>
        </div>
      </div>

      {erro && <div style={S.erroBox}>⚠️ {erro}</div>}

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : grupos.length === 0 ? (
        <p style={S.muted}>Nenhum acordo nesta fila.</p>
      ) : (
        <div style={S.cards}>
          {grupos.map((g) => (
            <div key={g.chave} style={S.card}>
              <div style={S.cardHead}>
                <div style={S.cardHeadInfo}>
                  <span style={S.cardNome}>{g.nome || "-"}</span>
                  <span style={S.cardCpf}>CPF {formatCpf(g.cpf)}</span>
                  {g.unidade && <span style={S.cardUnidade}>{g.unidade}</span>}
                </div>
                <div style={S.cardHeadDir}>
                  <span style={S.cardResumo}>{g.acordos.length} acordo{g.acordos.length > 1 ? "s" : ""} · {moeda(g.total)}</span>
                  <button type="button" style={S.btnFicha} onClick={() => setFichaId(g.alunoId)}>Abrir ficha</button>
                </div>
              </div>

              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.thNum}>Parcelas</th>
                    <th style={S.thNum}>Valor</th>
                    <th style={S.th}>Responsável pelo acordo</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {g.acordos.map((a) => {
                    const st = a.status_confirmacao || "A_CONFIRMAR";
                    const meta = STATUS_META[st] || STATUS_META.A_CONFIRMAR;
                    const busy = !!processando[a.id];
                    const resp = responsaveis[a.id];
                    const respTexto = responsavelAcordo(resp);
                    const semResp = respTexto === "Sem responsável";
                    return (
                      <tr key={a.id}>
                        <td style={S.tdNum}>{a.qtd_parcelas}</td>
                        <td style={S.tdNum}>{moeda(a.valor_total)}</td>
                        <td style={S.td}>
                          <span style={semResp ? S.respVazio : S.resp}>{respTexto}</span>
                        </td>
                        <td style={S.td}>
                          <span style={{ ...S.chip, ...S[meta.estilo] }}>{meta.rotulo}</span>
                        </td>
                        <td style={S.td}>
                          <div style={S.acoes}>
                            {st === "A_CONFIRMAR" && (
                              <>
                                <button type="button" style={{ ...S.btnConf, ...(busy ? S.btnBusy : {}) }} disabled={busy} onClick={() => confirmar(a)}>
                                  {busy ? "..." : "Confirmar"}
                                </button>
                                <button type="button" style={{ ...S.btnRej, ...(busy ? S.btnBusy : {}) }} disabled={busy} onClick={() => rejeitar(a)}>
                                  {busy ? "..." : "Rejeitar"}
                                </button>
                              </>
                            )}
                            {st === "REJEITADO" && (
                              <button type="button" style={{ ...S.btnMini, ...(busy ? S.btnBusy : {}) }} disabled={busy} onClick={() => reabrir(a)}>
                                {busy ? "..." : "reabrir"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button type="button" style={S.modalFechar} onClick={() => setFichaId(null)}>Fechar ✕</button>
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 24, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "5px 0 0", color: "#64748b", fontSize: 13 },
  btnGhost: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  barra: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 },
  select: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#0f172a" },
  input: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#0f172a", minWidth: 240, outline: "none" },
  contadores: { display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" },
  contadorAlunos: { fontSize: 12, fontWeight: 800, color: "#3730a3", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 999, padding: "4px 12px" },
  contadorAcordos: { fontSize: 12, fontWeight: 800, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "4px 12px" },
  contadorValor: { fontSize: 12, fontWeight: 800, color: "#334155", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "4px 12px" },
  erroBox: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginBottom: 14 },
  muted: { color: "#64748b", fontSize: 14 },
  cards: { display: "flex", flexDirection: "column", gap: 14 },
  card: { background: "#fff", borderRadius: 12, border: "1px solid #e6eaf0", overflow: "hidden", boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 16px", borderBottom: "1px solid #eef1f6", background: "#f8fafc" },
  cardHeadInfo: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  cardHeadDir: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  cardNome: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800, color: "#0d1321" },
  cardCpf: { fontSize: 12.5, color: "#64748b", fontWeight: 600 },
  cardUnidade: { fontSize: 12, color: "#8a93a3" },
  cardResumo: { fontSize: 12.5, color: "#475569", fontWeight: 700 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" },
  th: { textAlign: "left", padding: "9px 14px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#fff", borderBottom: "1px solid #eef1f6" },
  thNum: { textAlign: "right", padding: "9px 14px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#fff", borderBottom: "1px solid #eef1f6" },
  td: { padding: "10px 14px", borderBottom: "1px solid #f4f6f9", color: "#344054" },
  tdNum: { padding: "10px 14px", borderBottom: "1px solid #f4f6f9", textAlign: "right", fontWeight: 700, color: "#101828" },
  acoes: { display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" },
  resp: { fontSize: 12.5, fontWeight: 600, color: "#334155" },
  respVazio: { fontSize: 12.5, fontWeight: 600, color: "#94a3b8", fontStyle: "italic" },
  chip: { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" },
  chipPend: { background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a" },
  chipOk: { background: "#f0fdf4", color: "#166534", border: "1px solid #86efac" },
  chipRej: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" },
  btnConf: { background: "#15803d", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  btnRej: { background: "#b91c1c", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  btnMini: { background: "transparent", color: "#2563eb", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  btnBusy: { opacity: 0.55, cursor: "not-allowed" },
  btnFicha: { background: "#eef2ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "3vh 2vw", zIndex: 1000 },
  modalBox: { background: "#fff", borderRadius: 16, width: "min(1100px, 96vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e6eaf0", background: "#f8fafc" },
  modalTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800, color: "#0d1321" },
  modalFechar: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  modalConteudo: { overflow: "auto", flex: 1 },
};
