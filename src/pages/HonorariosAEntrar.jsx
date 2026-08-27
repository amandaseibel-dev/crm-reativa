import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import { nomeOperadorPorEmail } from "../utils/operadores";
import { buscarTudo } from "../utils/paginado";
import Aluno from "./Aluno";

// "Controle de Acordos" — o acompanhamento do que foi negociado.
//
// O QUE ESTA TELA É (Amanda, 27/08/2026): "lá é só o que está pendente de
// acordo a entrar, o que já está vencido, um controle dos acordos".
//
// Não é caixa. Não é a Projeção. É a parcela de acordo que AINDA TEM PARA
// ENTRAR, em dois estados:
//
//     A VENCER  -> ainda pode entrar
//     VENCIDA   -> venceu sem pagar; é a quebra, e continua devida
//
// Parcela já paga saiu da tela (Amanda, 27/08/2026: "o que entrou pode sair da
// lista"; "ali fica o controle do que tem para entrar"). Ela não é controle, é
// histórico -- quem quer o que entrou olha a Projeção. As linhas pagas ainda
// chegam da RPC, mas só para calcular a taxa de honorário da estimativa.
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

// Como o vencimento vira grupo na tela (Amanda, 27/08/2026: "deixa todos os
// anos de 2024 e 2025 junto, deixe aberto apenas 2026").
//
// O ano corrente e o que se trabalha: cada mes dele merece uma linha propria.
// O que ficou para tras nao se planeja mais por mes -- vira um bloco so, que e
// a divida velha. O que vence depois do ano corrente tambem: e previsao
// distante, nao pauta do dia.
//
// A chave leva um prefixo numerico so para ordenar: passado, meses, futuro.
const ANO_ABERTO = 2026;

function grupoDe(v) {
  const iso = String(v || "").slice(0, 10);
  const ano = Number(iso.slice(0, 4));
  if (!ano) return { chave: "9-sem-data", rotulo: "Sem data" };
  if (ano < ANO_ABERTO) return { chave: "0-passado", rotulo: `Até ${ANO_ABERTO - 1}` };
  if (ano > ANO_ABERTO) return { chave: "2-futuro", rotulo: `${ANO_ABERTO + 1} em diante` };
  return { chave: `1-${iso.slice(0, 7)}`, rotulo: mesDe(iso) };
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
  // Acordo sem dono: ninguem cobra e ninguem ve. O operador nunca enxerga essas
  // linhas -- a RPC casa pelo e-mail dele e o campo esta vazio -- entao so a
  // gestao pode achar (Amanda, 27/08/2026: "uma coluna visivel para mim e
  // fernanda e adm sem responsavel cadastrado").
  const [soSemResponsavel, setSoSemResponsavel] = useState(false);
  // So dois estados: a tela e de PENDENCIA (Amanda, 27/08/2026 -- "o que entrou
  // pode sair da lista"). Parcela paga nao e controle, e historico: quem quer o
  // que entrou olha a Projecao. As linhas PAGO ainda chegam da RPC, mas so para
  // calcular a taxa de honorario usada na estimativa do que falta preencher.
  const [estado, setEstado] = useState("VENCIDO");
  const [busca, setBusca] = useState("");
  // Grupos abertos. Comeca tudo fechado: a tela abre como um panorama, e a
  // pessoa escolhe onde entrar ("os meses quando clica aparece o que tem no mes
  // e os honorarios para entrar").
  // Comeca com o mes corrente aberto: e onde ela trabalha hoje. O resto fica
  // fechado -- inclusive o bloco dos anos anteriores, que e divida velha e nao
  // se planeja mais por mes.
  const [abertos, setAbertos] = useState(() => {
    const d = new Date();
    return new Set([`1-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`]);
  });
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
      // De mil em mil. A API corta em 1.000 linhas mesmo sem limite pedido, e
      // responde 206 -- que e SUCESSO. Sao 10.533 parcelas na visao da gestao:
      // chegava so ate 07/12/2025 e 2026 inteiro sumia da tela, sem erro nenhum
      // (Amanda, 27/08/2026: "precisa trazer o ano de 2026 tambem").
      const linhas = await buscarTudo((de, ate) =>
        supabase.rpc("honorarios_a_entrar", { p_email: email || null }).range(de, ate)
      );
      setLinhas(linhas);
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
    if (soSemResponsavel) lista = lista.filter((l) => !String(l.operador_email || "").trim());
    if (acionamento) lista = lista.filter((l) => passaAcionamento(l, acionamento));
    if (busca.trim()) {
      const t = busca.trim().toLowerCase();
      lista = lista.filter((l) => String(l.aluno_nome || "").toLowerCase().includes(t));
    }
    return lista;
  }, [linhas, estado, acionamento, busca, soSemResponsavel]);

  // Um card por grupo: um bloco para o que ficou para trás, um por mês de 2026,
  // um para o que vence depois.
  const meses = useMemo(() => {
    const mapa = new Map();
    for (const l of filtradas) {
      const g = grupoDe(l.vencimento);
      if (!mapa.has(g.chave)) mapa.set(g.chave, { chave: g.chave, rotulo: g.rotulo, itens: [] });
      mapa.get(g.chave).itens.push(l);
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

  // Quanto esta sem dono no estado em foco. So a gestao ve isso.
  const semDono = useMemo(() => {
    const l = linhas.filter((x) => x.estado === estado && !String(x.operador_email || "").trim());
    return {
      parcelas: l.length,
      acordos: contarAcordos(l),
      valor: l.reduce((s, x) => s + Number(x.valor || 0), 0),
    };
  }, [linhas, estado]);

  // Chave do grupo do mes corrente, para destacar.
  const mesAtual = useMemo(() => {
    const d = new Date();
    return `1-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  function alternar(chave) {
    setAbertos((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(chave)) proximo.delete(chave);
      else proximo.add(chave);
      return proximo;
    });
  }

  if (carregando) {
    return <div style={A.wrap}><Carregando texto="Somando os acordos…" /></div>;
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Controle de Acordos</h1>
          <p style={A.sub}>
            O que está pendente nos acordos: o que ainda pode entrar e o que já venceu sem pagar.
            Os cards do topo somam <b>tudo</b>. Abaixo, <b>2026 aparece mês a mês</b> e o que ficou
            para trás vem num bloco só. Clique num mês para ver as parcelas e o honorário dele.
            Parcela já paga não aparece aqui — para o que entrou, veja a Projeção.
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

      {ehGestao && !soSemResponsavel && semDono.parcelas > 0 && (
        <div style={estilos.avisoSemDono}>
          <b>{semDono.acordos} acordo{semDono.acordos > 1 ? "s" : ""} sem responsável cadastrado</b>
          {" "}({semDono.parcelas} parcela{semDono.parcelas > 1 ? "s" : ""}, {moeda(semDono.valor)}).
          Ninguém está cobrando: como a lista de cada operador casa pelo e-mail dele, essas linhas
          não aparecem para nenhum deles.{" "}
          <button
            type="button"
            style={estilos.linkSemDono}
            onClick={() => { setSoSemResponsavel(true); setOperadorFiltro("__SEM__"); carregar(""); }}
          >
            Ver só esses
          </button>
        </div>
      )}

      <div style={A.barra}>
        {ehGestao && (
          <select
            style={A.select}
            value={operadorFiltro}
            onChange={(e) => {
              const v = e.target.value;
              const sem = v === "__SEM__";
              setSoSemResponsavel(sem);
              setOperadorFiltro(v);
              // "Sem responsável" nao e um e-mail: busca tudo e filtra aqui.
              carregar(sem ? "" : v);
            }}
          >
            <option value="">Todos os operadores</option>
            <option value="__SEM__">⚠️ Sem responsável cadastrado</option>
            {operadores.filter(Boolean).map((o) => <option key={o} value={o}>{nomeOperadorPorEmail(o) || o}</option>)}
          </select>
        )}
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
              <div
                role="button"
                tabIndex={0}
                onClick={() => alternar(m.chave)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(m.chave); } }}
                style={{ ...A.cardHead, cursor: "pointer", ...(m.chave === mesAtual ? estilos.mesDestaque : {}) }}
              >
                <div style={A.cardHeadInfo}>
                  <span style={estilos.seta}>{abertos.has(m.chave) ? "▾" : "▸"}</span>
                  <span style={A.cardNome}>{m.rotulo}</span>
                  {m.chave === mesAtual && <span style={estilos.selo}>mês atual</span>}
                  <span style={estilos.acordosMes}>{m.acordos} acordo{m.acordos > 1 ? "s" : ""}</span>
                </div>
                <div style={A.cardHeadDir}>
                  <span style={A.cardResumo}>
                    {m.itens.length} parcela{m.itens.length > 1 ? "s" : ""} · {moeda(m.valor)} em aberto
                  </span>
                  <span style={estilos.honorarioMes}>{moeda(m.honorario)} de honorário a entrar</span>
                  {m.semHonorario > 0 && (
                    <span style={estilos.pendente}>{m.semHonorario} sem informar</span>
                  )}
                  {m.semAcionar > 0 && (
                    <span style={estilos.semAcionar}>{m.semAcionar} sem acionar hoje</span>
                  )}
                </div>
              </div>

              {abertos.has(m.chave) && (
              <table style={A.tabela}>
                <thead>
                  <tr>
                    <th style={A.th}>Aluno</th>
                    <th style={A.th}>Parcela</th>
                    <th style={A.th}>Vencimento</th>
                    <th style={A.thNum}>Valor</th>
                    <th style={A.thNum}>Honorário</th>
                    <th style={A.th}>Último acionamento</th>
                    {ehGestao && <th style={A.th}>Responsável</th>}
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
                        {ehGestao && (
                          <td style={A.td}>
                            {String(l.operador_email || "").trim()
                              ? (nomeOperadorPorEmail(l.operador_email) || l.operador_email)
                              : <span style={estilos.semDonoSelo}>sem responsável</span>}
                          </td>
                        )}
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
              )}
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
  cartoes: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 320px))", gap: 12, marginBottom: 14 },
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
  seta: { fontSize: 13, color: "#64748b", width: 12, display: "inline-block" },
  semDonoSelo: {
    display: "inline-block", fontSize: 11.5, fontWeight: 700, borderRadius: 999,
    padding: "2px 10px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca",
    whiteSpace: "nowrap",
  },
  avisoSemDono: {
    background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, marginBottom: 14,
  },
  linkSemDono: {
    border: "none", background: "none", padding: 0, color: "#991b1b",
    fontWeight: 800, fontSize: 13, cursor: "pointer", textDecoration: "underline",
  },
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
