import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import Aluno from "./Aluno";

// "O que tenho para entrar" — a previsão de honorário do operador.
//
// POR QUE ESTA TELA EXISTE. A Projeção mostra o que JÁ entrou, e só isso. O
// número pelo qual o operador é cobrado aparecia para ele depois de acontecer
// -- não havia onde ver o que ainda PODE entrar, nem o que se perdeu por quebra.
//
// Aqui estão os três lados juntos.
//
// DE ONDE VEM CADA NÚMERO -- e isso não é detalhe:
//
//     A VENCER / PERDIDO -> parcelas dos acordos ativos (é lá que mora o futuro)
//     ENTROU             -> pagamentos.valor_honorario, a MESMA fonte e o mesmo
//                           filtro da Projeção
//
// O "Entrou" já saiu de `parcelas.honorarios` e estava errado por duas ordens de
// grandeza: de 1.484 parcelas pagas, só 116 (7,8%) tinham o campo preenchido --
// a tela mostrava R$ 5 mil onde tinham entrado R$ 837 mil. Pior que o número
// baixo era o desacordo: duas telas dizendo coisas diferentes sobre o mesmo
// fato fazem ninguém confiar em nenhuma das duas. Agora batem por construção,
// operador a operador, até o centavo.
//
// A REGRA (Amanda, 26/08/2026): o honorário da parcela a vencer entra quando
// ela é paga; se não for paga, o acordo quebra e ele não entra. Por isso os
// três estados aparecem separados e nunca somados num número só:
//
//     A VENCER  -> ainda pode entrar
//     ENTROU    -> parcela paga
//     PERDIDO   -> venceu sem pagar; é a quebra
//
// FICA SEPARADA DA FILA de propósito (pedido da Amanda): a fila é o trabalho de
// hoje, isto é acompanhamento do que já foi negociado.

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

export default function HonorariosAEntrar() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [ehGestao, setEhGestao] = useState(false);
  const [operadorFiltro, setOperadorFiltro] = useState("");
  const [estado, setEstado] = useState("A_VENCER");
  const [busca, setBusca] = useState("");
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

  const filtradas = useMemo(() => {
    let lista = linhas.filter((l) => l.estado === estado);
    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      lista = lista.filter((l) => String(l.aluno_nome || "").toLowerCase().includes(t));
    }
    return lista;
  }, [linhas, estado, busca]);

  // Totais dos três estados: o operador precisa ver os três juntos para
  // entender a própria carteira -- o que pode entrar, o que entrou e o que a
  // quebra levou.
  const totais = useMemo(() => {
    const conta = (e) => {
      const l = linhas.filter((x) => x.estado === e);
      return {
        parcelas: l.length,
        valor: l.reduce((s, x) => s + Number(x.valor || 0), 0),
        honorario: l.reduce((s, x) => s + Number(x.honorario || 0), 0),
        semHonorario: l.filter((x) => Number(x.honorario || 0) === 0).length,
      };
    };
    return { A_VENCER: conta("A_VENCER"), PAGO: conta("PAGO"), VENCIDO: conta("VENCIDO") };
  }, [linhas]);

  // Agrupado por mês de vencimento: é assim que o operador pensa a meta.
  const meses = useMemo(() => {
    const mapa = new Map();
    for (const l of filtradas) {
      const k = chaveMes(l.vencimento);
      if (!mapa.has(k)) mapa.set(k, { chave: k, rotulo: mesDe(l.vencimento), itens: [] });
      mapa.get(k).itens.push(l);
    }
    const arr = [...mapa.values()];
    for (const m of arr) {
      m.valor = m.itens.reduce((s, x) => s + Number(x.valor || 0), 0);
      m.honorario = m.itens.reduce((s, x) => s + Number(x.honorario || 0), 0);
      m.semHonorario = m.itens.filter((x) => Number(x.honorario || 0) === 0).length;
    }
    arr.sort((a, b) => a.chave.localeCompare(b.chave));
    return arr;
  }, [filtradas]);

  const proximoMes = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  if (carregando) {
    return <div style={A.wrap}><Carregando texto="Somando o que tem para entrar…" /></div>;
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>O que tenho para entrar</h1>
          <p style={A.sub}>O que ainda pode entrar vem das parcelas dos seus acordos; o que entrou vem da mesma fonte da Projeção.</p>
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
          <span style={estilos.rotulo}>A vencer — pode entrar</span>
          <span style={estilos.numero}>{moeda(totais.A_VENCER.honorario)}</span>
          <span style={estilos.detalhe}>
            {totais.A_VENCER.parcelas} parcelas · {moeda(totais.A_VENCER.valor)} de dívida
          </span>
        </button>

        <button
          type="button"
          onClick={() => setEstado("PAGO")}
          style={{ ...estilos.cartao, ...(estado === "PAGO" ? estilos.cartaoAtivo : {}) }}
        >
          <span style={estilos.rotulo}>Entrou — honorário recebido</span>
          <span style={{ ...estilos.numero, color: "#15803d" }}>{moeda(totais.PAGO.honorario)}</span>
          <span style={estilos.detalhe}>
            {totais.PAGO.parcelas} pagamento{totais.PAGO.parcelas === 1 ? "" : "s"} · {moeda(totais.PAGO.valor)} recebidos
          </span>
        </button>

        <button
          type="button"
          onClick={() => setEstado("VENCIDO")}
          style={{ ...estilos.cartao, ...(estado === "VENCIDO" ? estilos.cartaoAtivo : {}) }}
        >
          <span style={estilos.rotulo}>Perdido — venceu sem pagar</span>
          <span style={{ ...estilos.numero, color: "#b91c1c" }}>{moeda(totais.VENCIDO.honorario)}</span>
          <span style={estilos.detalhe}>
            {totais.VENCIDO.parcelas} parcelas · {moeda(totais.VENCIDO.valor)} em atraso
          </span>
        </button>
      </div>

      {estado !== "PAGO" && totais[estado].semHonorario > 0 && (
        <div style={estilos.avisoSemHonorario}>
          <b>{totais[estado].semHonorario} destas parcelas estão sem honorário informado.</b> Elas
          contam na dívida, mas somam zero aqui — os acordos vieram por importação, que não trazia o
          campo. Para cada uma, abra a ficha do aluno e use <b>“Informar honorários”</b> no card do
          acordo. O valor se distribui pelas parcelas em aberto e passa a aparecer nesta tela.
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
            {operadores.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        <input
          style={A.input}
          placeholder="Buscar por aluno..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div style={A.contadores}>
          <span style={A.contadorAlunos}>{meses.length} meses</span>
          <span style={A.contadorAcordos}>{filtradas.length} {estado === "PAGO" ? "pagamentos" : "parcelas"}</span>
          <span style={A.contadorValor}>{moeda(filtradas.reduce((s, x) => s + Number(x.honorario || 0), 0))}</span>
        </div>
      </div>

      {meses.length === 0 ? (
        <p style={A.muted}>Nada neste filtro.</p>
      ) : (
        <div style={A.cards}>
          {meses.map((m) => (
            <div key={m.chave} style={A.card}>
              <div style={{ ...A.cardHead, ...(m.chave === proximoMes ? estilos.mesDestaque : {}) }}>
                <div style={A.cardHeadInfo}>
                  <span style={A.cardNome}>{m.rotulo}</span>
                  {m.chave === proximoMes && <span style={estilos.selo}>próximo mês</span>}
                </div>
                <div style={A.cardHeadDir}>
                  <span style={A.cardResumo}>
                    {m.itens.length} {estado === "PAGO" ? "pagamento" : "parcela"}{m.itens.length > 1 ? "s" : ""} · {moeda(m.valor)} {estado === "PAGO" ? "recebidos" : "de dívida"}
                  </span>
                  <span style={estilos.honorarioMes}>{moeda(m.honorario)} de honorário</span>
                  {m.semHonorario > 0 && (
                    <span style={estilos.pendente}>{m.semHonorario} sem informar</span>
                  )}
                </div>
              </div>

              <table style={A.tabela}>
                <thead>
                  <tr>
                    <th style={A.th}>Aluno</th>
                    <th style={A.th}>{estado === "PAGO" ? "Origem" : "Parcela"}</th>
                    <th style={A.th}>{estado === "PAGO" ? "Pago em" : "Vencimento"}</th>
                    <th style={A.thNum}>Valor</th>
                    <th style={A.thNum}>Honorário</th>
                    <th style={A.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {m.itens.map((l) => (
                    <tr key={l.parcela_id || `${l.aluno_id}-${l.vencimento}-${l.valor}`}>
                      <td style={A.td}>{l.aluno_nome}</td>
                      <td style={A.td}>{l.is_entrada ? "Entrada" : l.numero != null ? `Parcela ${l.numero}` : "Pagamento"}</td>
                      <td style={A.td}>{dia(l.vencimento)}</td>
                      <td style={A.tdNum}>{moeda(l.valor)}</td>
                      <td style={A.tdNum}>
                        {Number(l.honorario || 0) > 0
                          ? moeda(l.honorario)
                          : <span style={estilos.zerado}>não informado</span>}
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
                  ))}
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
  avisoSemHonorario: {
    background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, marginBottom: 14,
  },
  mesDestaque: { background: "#eef2ff" },
  selo: {
    fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#1e40af", color: "#fff", whiteSpace: "nowrap",
  },
  honorarioMes: { fontSize: 13, fontWeight: 800, color: "#15803d" },
  pendente: {
    fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 10px",
    background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", whiteSpace: "nowrap",
  },
  zerado: { fontSize: 12, color: "#b45309", fontStyle: "italic" },
};
