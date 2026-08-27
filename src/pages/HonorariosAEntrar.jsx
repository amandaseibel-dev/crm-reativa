import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import { nomeOperadorPorEmail } from "../utils/operadores";
import Aluno from "./Aluno";

// "Controle de Acordos" — o acompanhamento do que foi negociado.
//
// O QUE ESTA TELA É (Amanda, 27/08/2026): "lá é só o que está pendente de
// acordo a entrar, o que já está vencido, um controle dos acordos".
//
// Não é caixa. Não é a Projeção. É a parcela de acordo em três estados -- e os
// três são estados da MESMA coisa, por isso saem todos de `parcelas`:
//
//     A VENCER  -> ainda pode entrar
//     ENTROU    -> parcela paga
//     VENCIDA   -> venceu sem pagar; é a quebra
//
// Já errei aqui uma vez: fiz o "Entrou" ler `pagamentos`, a fonte da Projeção.
// O número ficava certo como "honorário do mês", mas passava a incluir
// pagamento de mensalidade -- que não é acordo -- e a tela deixava de responder
// a pergunta que existe para responder. Voltou para `parcelas`; o honorário do
// pago vem da BAIXA (o que de fato entrou) e só cai para `parcelas.honorarios`
// quando não há baixa.
//
// COMO SE LÊ:
//   topo   -> tudo, todos os meses. O tamanho da carteira de acordos.
//   cards  -> mês a mês: quantos acordos, quanto em aberto, quanto de honorário.
//   linha  -> o aluno, e há quantos dias ele não é acionado.
//
// O ACIONAMENTO na linha existe porque isto virou lista de trabalho: em agosto
// são 953 parcelas vencidas. Sem ver quem já foi acionado, o operador liga duas
// vezes para a mesma pessoa e nunca chega no fim da lista.

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dia(v) {
  if (!v) return "-";
  const [a, m, d] = String(v).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

// Rótulo do mês a partir de uma data ISO, sem passar por fuso.
function mesDe(v) {
  if (!v) return "sem data";
  const [ano, mes] = String(v).slice(0, 10).split("-");
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${nomes[Number(mes) - 1] || mes}/${ano}`;
}

function chaveMes(v) {
  return String(v || "").slice(0, 7);
}

function contarAcordos(itens) {
  return new Set(itens.map((x) => x.acordo_id).filter(Boolean)).size;
}

// Como o acionamento aparece na linha. O operador precisa de UMA olhada, não de
// uma conta: "hoje" e "ontem" por extenso, o resto em dias, e nunca acionado em
// destaque, porque é onde tem chance de ter alguém intocado.
function selo(l) {
  const d = l.dias_sem_acionamento;
  if (d == null) return { txt: "nunca acionado", cor: "#b91c1c", fundo: "#fef2f2", borda: "#fecaca" };
  if (d === 0) return { txt: "hoje", cor: "#15803d", fundo: "#f0fdf4", borda: "#bbf7d0" };
  if (d === 1) return { txt: "ontem", cor: "#15803d", fundo: "#f0fdf4", borda: "#bbf7d0" };
  if (d <= 7) return { txt: `há ${d} dias`, cor: "#92400e", fundo: "#fffbeb", borda: "#fde68a" };
  return { txt: `há ${d} dias`, cor: "#b91c1c", fundo: "#fef2f2", borda: "#fecaca" };
}

const FILTROS_ACIONAMENTO = [
  { v: "", label: "Qualquer acionamento" },
  { v: "PENDENTE", label: "Ainda não acionei hoje" },
  { v: "NUNCA", label: "Nunca acionados" },
  { v: "FRIO", label: "Parados há 8 dias ou mais" },
  { v: "HOJE", label: "Acionados hoje" },
];

function passaAcionamento(l, f) {
  const d = l.dias_sem_acionamento;
  if (f === "PENDENTE") return d !== 0;
  if (f === "NUNCA") return d == null;
  if (f === "FRIO") return d == null || d >= 8;
  if (f === "HOJE") return d === 0;
  return true;
}

export default function HonorariosAEntrar() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [ehGestao, setEhGestao] = useState(false);
  const [operadorFiltro, setOperadorFiltro] = useState("");
  const [estado, setEstado] = useState("VENCIDO");
  const [busca, setBusca] = useState("");
  const [mesFoco, setMesFoco] = useState("");
  const [acionamento, setAcionamento] = useState("");
  const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.rpc("usuario_e_gestao");
        setEhGestao(data === true);
      } catch {
        setEhGestao(false);
      }
      await carregar("");
    })();
  }, []);

  async function carregar(email) {
    setCarregando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("honorarios_a_entrar", {
        p_email: email || null,
      });
      if (error) throw error;
      setLinhas(data || []);
    } catch (e) {
      setErro(e?.message || String(e));
      setLinhas([]);
    } finally {
      setCarregando(false);
    }
  }

  const operadores = useMemo(() => {
    const set = new Set(linhas.map((l) => l.operador_email).filter(Boolean));
    return [...set].sort();
  }, [linhas]);

  const mesesDisponiveis = useMemo(() => {
    const set = new Set(linhas.map((l) => chaveMes(l.vencimento)).filter(Boolean));
    return [...set].sort();
  }, [linhas]);

  // TOPO: o total de TODOS os meses, sempre. É o tamanho da carteira de acordos
  // -- não muda quando ela escolhe um mês, senão ela perde a referência do todo.
  const totais = useMemo(() => {
    const conta = (e) => {
      const l = linhas.filter((x) => x.estado === e);
      return {
        parcelas: l.length,
        acordos: contarAcordos(l),
        valor: l.reduce((s, x) => s + Number(x.valor || 0), 0),
        honorario: l.reduce((s, x) => s + Number(x.honorario || 0), 0),
        semHonorario: l.filter((x) => Number(x.honorario || 0) === 0).length,
      };
    };
    return { A_VENCER: conta("A_VENCER"), PAGO: conta("PAGO"), VENCIDO: conta("VENCIDO") };
  }, [linhas]);

  const filtradas = useMemo(() => {
    let lista = linhas.filter((l) => l.estado === estado);
    if (mesFoco) lista = lista.filter((l) => chaveMes(l.vencimento) === mesFoco);
    if (acionamento) lista = lista.filter((l) => passaAcionamento(l, acionamento));
    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      lista = lista.filter((l) => String(l.aluno_nome || "").toLowerCase().includes(t));
    }
    return lista;
  }, [linhas, estado, mesFoco, acionamento, busca]);

  // Um card por mês de vencimento: é assim que ela planeja.
  const meses = useMemo(() => {
    const mapa = new Map();
    for (const l of filtradas) {
      const k = chaveMes(l.vencimento);
      if (!mapa.has(k)) mapa.set(k, { chave: k, rotulo: mesDe(l.vencimento), itens: [] });
      mapa.get(k).itens.push(l);
    }
    const arr = [...mapa.values()];
    for (const m of arr) {
      m.acordos = contarAcordos(m.itens);
      m.valor = m.itens.reduce((s, x) => s + Number(x.valor || 0), 0);
      m.honorario = m.itens.reduce((s, x) => s + Number(x.honorario || 0), 0);
      m.semHonorario = m.itens.filter((x) => Number(x.honorario || 0) === 0).length;
      m.semAcionar = m.itens.filter((x) => x.dias_sem_acionamento !== 0).length;
      m.itens.sort((a, b) => {
        // Dentro do mês, primeiro quem está mais tempo sem acionamento.
        const da = a.dias_sem_acionamento == null ? 9999 : a.dias_sem_acionamento;
        const db = b.dias_sem_acionamento == null ? 9999 : b.dias_sem_acionamento;
        if (da !== db) return db - da;
        return String(a.aluno_nome || "").localeCompare(String(b.aluno_nome || ""));
      });
    }
    arr.sort((a, b) => a.chave.localeCompare(b.chave));
    return arr;
  }, [filtradas]);

  const mesAtual = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  if (carregando) {
    return <div style={A.wrap}><Carregando texto="Somando os acordos…" /></div>;
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Controle de Acordos</h1>
          <p style={A.sub}>
            Os três estados da parcela do acordo. Os cards do topo somam <b>todos os meses</b>;
            clique num deles para abrir a lista, mês a mês.
          </p>
        </div>
        <button type="button" style={A.btnGhost} onClick={() => carregar(operadorFiltro)}>Atualizar</button>
      </div>

      {erro && <div style={A.erroBox}>⚠️ {erro}</div>}

      <div style={estilos.cartoes}>
        <button
          type="button"
          onClick={() => setEstado("A_VENCER")}
          style={{ ...estilos.cartao, ...(estado === "A_VENCER" ? estilos.cartaoAtivo : {}) }}
        >
          <span style={estilos.rotulo}>A vencer — ainda pode entrar</span>
          <span style={estilos.numero}>{moeda(totais.A_VENCER.valor)}</span>
          <span style={estilos.detalhe}>
            {totais.A_VENCER.acordos} acordos · {totais.A_VENCER.parcelas} parcelas
          </span>
          <span style={estilos.honorarioLinha}>{moeda(totais.A_VENCER.honorario)} de honorário</span>
        </button>

        <button
          type="button"
          onClick={() => setEstado("VENCIDO")}
          style={{ ...estilos.cartao, ...(estado === "VENCIDO" ? estilos.cartaoAtivo : {}), borderLeft: "4px solid #b91c1c" }}
        >
          <span style={estilos.rotulo}>Vencida — a quebra</span>
          <span style={{ ...estilos.numero, color: "#b91c1c" }}>{moeda(totais.VENCIDO.valor)}</span>
          <span style={estilos.detalhe}>
            {totais.VENCIDO.acordos} acordos · {totais.VENCIDO.parcelas} parcelas
          </span>
          <span style={estilos.honorarioLinha}>{moeda(totais.VENCIDO.honorario)} de honorário</span>
        </button>

        <button
          type="button"
          onClick={() => setEstado("PAGO")}
          style={{ ...estilos.cartao, ...(estado === "PAGO" ? estilos.cartaoAtivo : {}) }}
        >
          <span style={estilos.rotulo}>Entrou — parcela paga</span>
          <span style={{ ...estilos.numero, color: "#15803d" }}>{moeda(totais.PAGO.valor)}</span>
          <span style={estilos.detalhe}>
            {totais.PAGO.acordos} acordos · {totais.PAGO.parcelas} parcelas
          </span>
          <span style={estilos.honorarioLinha}>{moeda(totais.PAGO.honorario)} de honorário</span>
        </button>
      </div>

      {estado === "A_VENCER" && totais.A_VENCER.semHonorario > 0 && (() => {
        // Quanto do que está por vencer NÃO tem honorário informado -- e quanto
        // isso seria, na taxa do que já entrou. Sem isso o card mostra um número
        // que a pessoa acha ser "o que vai entrar", quando na verdade é "o que
        // alguém lembrou de preencher".
        const semHon = totais.A_VENCER.semHonorario;
        const taxa = totais.PAGO.valor > 0 ? totais.PAGO.honorario / totais.PAGO.valor : 0;
        const valorSemHon = linhas
          .filter((l) => l.estado === "A_VENCER" && Number(l.honorario || 0) === 0)
          .reduce((s2, l) => s2 + Number(l.valor || 0), 0);
        return (
          <div style={estilos.avisoSemHonorario}>
            <b>{semHon} de {totais.A_VENCER.parcelas} parcelas estão sem honorário informado</b>
            {" "}({moeda(valorSemHon)} de dívida).
            {taxa > 0 && (
              <> Na taxa do que já entrou ({(taxa * 100).toFixed(1)}%), isso seria cerca de{" "}
              <b>{moeda(valorSemHon * taxa)}</b> a mais para entrar.</>
            )}
            {" "}O honorário do card mostra só o que foi preenchido, não o total previsto.
          </div>
        );
      })()}

      {estado === "VENCIDO" && totais.VENCIDO.semHonorario > 0 && (
        <div style={estilos.avisoSemHonorario}>
          <b>{totais.VENCIDO.semHonorario} destas parcelas estão sem honorário informado.</b> Elas
          contam na dívida, mas somam zero no honorário — os acordos vieram por importação, que não
          trazia o campo. Para cada uma, abra a ficha do aluno e use <b>“Informar honorários”</b> no
          card do acordo.
        </div>
      )}

      <div style={A.barra}>
        {ehGestao && (
          <select
            style={A.select}
            value={operadorFiltro}
            onChange={(e) => { setOperadorFiltro(e.target.value); carregar(e.target.value); }}
          >
            <option value="">Todos os operadores</option>
            {operadores.map((o) => <option key={o} value={o}>{nomeOperadorPorEmail(o) || o}</option>)}
          </select>
        )}
        <select
          style={A.select}
          value={mesFoco}
          onChange={(e) => setMesFoco(e.target.value)}
          title="Mostrar só um mês na lista"
        >
          <option value="">Todos os meses</option>
          {mesesDisponiveis.map((m) => (
            <option key={m} value={m}>{mesDe(m + "-01")}</option>
          ))}
        </select>
        <select
          style={A.select}
          value={acionamento}
          onChange={(e) => setAcionamento(e.target.value)}
          title="Filtrar pelo último acionamento do aluno"
        >
          {FILTROS_ACIONAMENTO.map((f) => (
            <option key={f.v} value={f.v}>{f.label}</option>
          ))}
        </select>
        <input
          style={A.input}
          placeholder="Buscar por aluno..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div style={A.contadores}>
          <span style={A.contadorAlunos}>{contarAcordos(filtradas)} acordos</span>
          <span style={A.contadorAcordos}>{filtradas.length} parcelas</span>
          <span style={A.contadorValor}>{moeda(filtradas.reduce((s, x) => s + Number(x.valor || 0), 0))}</span>
        </div>
      </div>

      {meses.length === 0 ? (
        <p style={A.muted}>Nada neste filtro.</p>
      ) : (
        <div style={A.cards}>
          {meses.map((m) => (
            <div key={m.chave} style={A.card}>
              <div style={{ ...A.cardHead, ...(m.chave === mesAtual ? estilos.mesDestaque : {}) }}>
                <div style={A.cardHeadInfo}>
                  <span style={A.cardNome}>{m.rotulo}</span>
                  {m.chave === mesAtual && <span style={estilos.selo}>mês atual</span>}
                  <span style={estilos.acordosMes}>{m.acordos} acordo{m.acordos > 1 ? "s" : ""}</span>
                </div>
                <div style={A.cardHeadDir}>
                  <span style={A.cardResumo}>
                    {m.itens.length} parcela{m.itens.length > 1 ? "s" : ""} · {moeda(m.valor)}{" "}
                    {estado === "PAGO" ? "recebidos" : "em aberto"}
                  </span>
                  <span style={estilos.honorarioMes}>{moeda(m.honorario)} de honorário</span>
                  {m.semHonorario > 0 && (
                    <span style={estilos.pendente}>{m.semHonorario} sem informar</span>
                  )}
                  {estado !== "PAGO" && m.semAcionar > 0 && (
                    <span style={estilos.semAcionar}>{m.semAcionar} sem acionar hoje</span>
                  )}
                </div>
              </div>

              <table style={A.tabela}>
                <thead>
                  <tr>
                    <th style={A.th}>Aluno</th>
                    <th style={A.th}>Parcela</th>
                    <th style={A.th}>{estado === "PAGO" ? "Pago em" : "Vencimento"}</th>
                    <th style={A.thNum}>Valor</th>
                    <th style={A.thNum}>Honorário</th>
                    <th style={A.th}>Último acionamento</th>
                    <th style={A.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {m.itens.map((l) => {
                    const s = selo(l);
                    return (
                      <tr key={l.parcela_id || `${l.aluno_id}-${l.vencimento}-${l.valor}`}>
                        <td style={A.td}>{l.aluno_nome}</td>
                        <td style={A.td}>{l.is_entrada ? "Entrada" : l.numero != null ? `Parcela ${l.numero}` : "Parcela"}</td>
                        <td style={A.td}>{dia(l.vencimento)}</td>
                        <td style={A.tdNum}>{moeda(l.valor)}</td>
                        <td style={A.tdNum}>
                          {Number(l.honorario || 0) > 0
                            ? moeda(l.honorario)
                            : <span style={estilos.zerado}>não informado</span>}
                        </td>
                        <td style={A.td}>
                          <span
                            style={{
                              ...estilos.seloAcion,
                              color: s.cor, background: s.fundo, borderColor: s.borda,
                            }}
                            title={l.ultimo_acionamento ? `Acionado em ${dia(l.ultimo_acionamento)}` : "Sem acionamento registrado"}
                          >
                            {s.txt}
                          </span>
                          {l.tabulacao && <div style={estilos.tabulacao}>{l.tabulacao}</div>}
                        </td>
                        <td style={A.td}>
                          <div style={A.acoes}>
                            {l.aluno_id && (
                              <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                                Abrir ficha
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
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => { setFichaId(null); carregar(operadorFiltro); }}
              >
                Fechar ✕
              </button>
            </div>
            <div style={A.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  cartoes: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, marginBottom: 14 },
  cartao: {
    textAlign: "left", cursor: "pointer", background: "#fff",
    border: "1px solid #e6eaf0", borderRadius: 12, padding: "14px 16px",
    display: "flex", flexDirection: "column", gap: 4,
  },
  cartaoAtivo: { borderColor: "#1e40af", boxShadow: "0 0 0 2px rgba(30,64,175,0.12)" },
  rotulo: { fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" },
  numero: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 24, fontWeight: 800, color: "#0d1321" },
  detalhe: { fontSize: 12.5, color: "#64748b" },
  honorarioLinha: { fontSize: 12.5, fontWeight: 700, color: "#15803d" },
  avisoSemHonorario: {
    background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, marginBottom: 14,
  },
  mesDestaque: { background: "#eef2ff" },
  selo: {
    fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#1e40af", color: "#fff", whiteSpace: "nowrap",
  },
  acordosMes: {
    fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0", whiteSpace: "nowrap",
  },
  honorarioMes: { fontSize: 13, fontWeight: 800, color: "#15803d" },
  pendente: {
    fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", whiteSpace: "nowrap",
  },
  semAcionar: {
    fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#eff6ff", color: "#1e40af", border: "1px solid #bfdbfe", whiteSpace: "nowrap",
  },
  seloAcion: {
    display: "inline-block", fontSize: 11.5, fontWeight: 700, borderRadius: 999,
    padding: "2px 10px", border: "1px solid", whiteSpace: "nowrap",
  },
  tabulacao: { fontSize: 11.5, color: "#64748b", marginTop: 3, maxWidth: 220 },
  zerado: { fontSize: 12, color: "#b45309", fontStyle: "italic" },
};
