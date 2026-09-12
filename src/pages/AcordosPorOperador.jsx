import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import BotaoAtualizar from "../components/BotaoAtualizar";
import { S as A } from "../ui/estilosFila";
import Aluno from "./Aluno";
import { nomeOperadorPorEmail } from "../utils/operadores";
import { qtdQuebrados, vencidoQuebrado, ESTADO_QUEBRADO } from "../utils/acordoDono";

// Acordos vivos por operador: a vencer, vencido e quebrado.
//
// A tela que faltava: Efetividade mede esforço, Saúde da Carteira mede estoque,
// e nada acompanhava o acordo DEPOIS de fechado. Cada número aqui abre a lista
// de alunos por trás dele -- senão é relatório, não fila de trabalho.
//
// SOB DEMANDA, como as outras telas pesadas de gestão: sem auto-load nem
// polling. Um clique carrega.

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

// O rótulo é "quebrado" -- foi como a gestão pediu em 03/09. O que a decisão
// de 02/09 mantém é a regra do saldo: quando o acordo volta para a fila, volta
// com o saldo DO ACORDO, e a mensalidade de origem não ressuscita.
const ESTADOS = {
  EM_DIA: { rotulo: "Em dia", cor: "var(--rv-verde-ok-texto)", fundo: "var(--rv-verde-ok-fundo)" },
  ATRASADO: { rotulo: "Atrasado", cor: "var(--rv-ambar-texto)", fundo: "var(--rv-ambar-fundo)" },
  QUEBRADO: { rotulo: "Quebrado", cor: "var(--rv-vermelho-texto)", fundo: "var(--rv-vermelho-fundo)" },
  VENCE_7: { rotulo: "Vence em 7 dias", cor: "var(--rv-azul-texto)", fundo: "var(--rv-azul-fundo)" },
  VENCE_30: { rotulo: "Vence em 30 dias", cor: "var(--rv-azul-texto)", fundo: "var(--rv-azul-fundo)" },
  TODOS: { rotulo: "Todos os acordos", cor: "var(--rv-texto-forte)", fundo: "var(--rv-borda)" },
};

const POR_PAGINA = 100;


export default function AcordosPorOperador() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [ultimaEm, setUltimaEm] = useState(null);
  const [jaRodou, setJaRodou] = useState(false);
  const [drill, setDrill] = useState(null); // { email, nome, estado }
  const emVoo = useRef(false);

  async function atualizar() {
    if (emVoo.current) return;
    emVoo.current = true;
    setCarregando(true);
    setErro("");
    try {
      const { data: d, error } = await supabase.rpc("carteira_acordos_por_operador");
      if (error) throw error;
      setDados(d);
      setUltimaEm(new Date());
    } catch (e) {
      setErro(e?.message || String(e));
      setDados(null);
    } finally {
      setJaRodou(true);
      emVoo.current = false;
      setCarregando(false);
    }
  }

  const linhas = useMemo(() => dados?.linhas || [], [dados]);
  const totais = dados?.totais || {};
  const pctEmDia = totais.acordos ? (100 * Number(totais.em_dia || 0)) / Number(totais.acordos) : 0;

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Acordos vivos por operador</h1>
          <p style={S.subtitulo}>
            O que cada operador tem de acordo em pé, o que já venceu e o que entra nos próximos dias.
            Clique em qualquer número para ver os alunos.
          </p>
        </div>
        <BotaoAtualizar carregando={carregando} ultimaEm={ultimaEm} onClick={atualizar} rotulo="Atualizar acordos" />
      </div>

      {!jaRodou && !carregando && (
        <div style={S.vazio}>Clique em <b>Atualizar acordos</b> para carregar.</div>
      )}
      {erro && <div style={S.erro}>Não foi possível carregar: {erro}</div>}

      {dados && (
        <>
          <div style={S.cards}>
            <Card rotulo="Acordos ativos" valor={num(totais.acordos)} nota={moeda(totais.saldo) + " de saldo"} />
            <Card
              rotulo="Em dia"
              valor={num(totais.em_dia)}
              nota={pctEmDia.toFixed(1) + "% dos acordos"}
              cor={ESTADOS.EM_DIA.cor}
            />
            <Card
              rotulo="Quebrados"
              valor={num(qtdQuebrados(totais))}
              nota={moeda(vencidoQuebrado(totais)) + " vencidos"}
              cor={ESTADOS.QUEBRADO.cor}
            />
            <Card
              rotulo="Vence em 7 dias"
              valor={moeda(totais.valor_7d)}
              nota={num(totais.parcelas_7d) + " parcelas"}
              cor={ESTADOS.VENCE_7.cor}
            />
            <Card
              rotulo="Vence em 30 dias"
              valor={moeda(totais.valor_30d)}
              nota={num(totais.parcelas_30d) + " parcelas"}
              cor={ESTADOS.VENCE_7.cor}
            />
          </div>

          <div style={S.bloco}>
            <div style={S.rolagem}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Operador</th>
                    <th style={S.thNum}>Acordos</th>
                    <th style={S.thNum}>Saldo</th>
                    <th style={{ ...S.th, minWidth: 150 }}>Em dia · atrasado · quebrado</th>
                    <th style={S.thNum}>Em dia</th>
                    <th style={S.thNum}>Atrasados</th>
                    <th style={S.thNum}>Quebrados</th>
                    <th style={S.thNum}>Vencido</th>
                    <th style={S.thNum}>Vence 7d</th>
                    <th style={S.thNum}>Vence 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => {
                    const t = Number(l.acordos) || 1;
                    const chave = l.sem_dono ? "sem-responsavel" : l.operador_email;
                    return (
                      <tr key={chave} style={l.sem_dono ? S.trAlerta : undefined}>
                        <td style={S.td}>
                          <span style={S.nome}>{l.operador_nome}</span>
                          {l.sem_dono && <span style={S.selo}>ninguém vê</span>}
                        </td>
                        <td style={S.tdNum}>
                          <Botao onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "TODOS" })}>
                            {num(l.acordos)}
                          </Botao>
                        </td>
                        <td style={S.tdNum}>{moeda(l.saldo)}</td>
                        <td style={S.td}>
                          <div style={S.trilho}>
                            <i style={{ ...S.fatia, width: pct(l.em_dia, t), background: ESTADOS.EM_DIA.cor }} />
                            <i style={{ ...S.fatia, width: pct(l.atrasados, t), background: ESTADOS.ATRASADO.cor }} />
                            <i style={{ ...S.fatia, width: pct(qtdQuebrados(l), t), background: ESTADOS.QUEBRADO.cor }} />
                          </div>
                        </td>
                        <td style={S.tdNum}>
                          <Botao cor={ESTADOS.EM_DIA.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "EM_DIA" })}>
                            {num(l.em_dia)}
                          </Botao>
                        </td>
                        <td style={S.tdNum}>
                          <Botao cor={ESTADOS.ATRASADO.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "ATRASADO" })}>
                            {num(l.atrasados)}
                          </Botao>
                        </td>
                        <td style={S.tdNum}>
                          <Botao cor={ESTADOS.QUEBRADO.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: ESTADO_QUEBRADO })}>
                            {num(qtdQuebrados(l))}
                          </Botao>
                          {Number(l.dias_atraso_medio) > 0 && (
                            <span style={S.nota}>{num(l.dias_atraso_medio)}d</span>
                          )}
                        </td>
                        <td style={S.tdNum}>{moeda(l.vencido_total)}</td>
                        <td style={S.tdNum}>
                          <Botao cor={ESTADOS.VENCE_7.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "VENCE_7" })}>
                            {moeda(l.valor_7d)}
                          </Botao>
                        </td>
                        <td style={S.tdNum}>
                          <Botao cor={ESTADOS.VENCE_7.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "VENCE_30" })}>
                            {moeda(l.valor_30d)}
                          </Botao>
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={S.trTotal}>
                    <td style={S.td}>Total</td>
                    <td style={S.tdNum}>{num(totais.acordos)}</td>
                    <td style={S.tdNum}>{moeda(totais.saldo)}</td>
                    <td style={S.td} />
                    <td style={S.tdNum}>{num(totais.em_dia)}</td>
                    <td style={S.tdNum}>{num(totais.atrasados)}</td>
                    <td style={S.tdNum}>{num(qtdQuebrados(totais))}</td>
                    <td style={S.tdNum}>{moeda(totais.vencido_total)}</td>
                    <td style={S.tdNum}>{moeda(totais.valor_7d)}</td>
                    <td style={S.tdNum}>{moeda(totais.valor_30d)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p style={S.legenda}>
              <Ponto cor={ESTADOS.EM_DIA.cor} /> Em dia — nenhuma parcela vencida
              <Ponto cor={ESTADOS.ATRASADO.cor} /> Atrasado — 1 ou 2 vencidas
              <Ponto cor={ESTADOS.QUEBRADO.cor} /> Quebrado — 3 ou mais vencidas
            </p>
            <p style={S.rodape}>
              O dono de cada acordo é <b>acordos.operador_responsavel_email</b> — o responsável do
              ACORDO. O responsável da ficha do aluno manda na mensalidade e não herda o acordo (nem o
              contrário): acordo de aluno cuja ficha é de outra pessoa aparece aqui para quem tem o
              acordo. Acordo sem responsável é <b>Sem responsável</b>, não é de ninguém: continua
              visível de propósito, porque é o que a próxima remessa precisa corrigir.
            </p>
          </div>
        </>
      )}

      {drill && <Gaveta {...drill} onFechar={() => setDrill(null)} />}
    </div>
  );
}

function pct(parte, total) {
  const v = (100 * Number(parte || 0)) / Number(total || 1);
  return v > 0 ? Math.max(v, 1.5) + "%" : "0%";
}

function Card({ rotulo, valor, nota, cor }) {
  return (
    <div style={S.card}>
      <span style={S.cardRot}>{rotulo}</span>
      <span style={{ ...S.cardVal, color: cor || "var(--rv-tinta)" }}>{valor}</span>
      <span style={S.cardNota}>{nota}</span>
    </div>
  );
}

function Botao({ children, onClick, cor }) {
  return (
    <button type="button" onClick={onClick} style={{ ...S.botaoNum, color: cor || "var(--rv-tinta)" }}>
      {children}
    </button>
  );
}

function Ponto({ cor }) {
  return <i style={{ ...S.ponto, background: cor }} />;
}

// Gaveta: a lista por trás do número. Pagina de 100 em 100 -- a RPC ordena por
// valor vencido com o id como desempate, então virar página não repete linha.
function Gaveta({ email, nome, estado, onFechar }) {
  // Ficha do aluno em popup por cima da gaveta, no mesmo padrão das outras
  // telas de gestão (`<Aluno fichaEmbedId>`): quem está conferindo a lista de
  // um operador não deve ser levado embora da tela a cada aluno.
  const [fichaId, setFichaId] = useState(null);
  const [pagina, setPagina] = useState(0);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const pedido = useRef(0);

  const carregar = useCallback(
    async (p) => {
      // Contador de pedido: virar página rápido pode fazer a resposta antiga
      // chegar depois da nova. Só a última pedida escreve na tela.
      const meu = ++pedido.current;
      setCarregando(true);
      setErro("");
      try {
        const { data: d, error } = await supabase.rpc("carteira_acordos_detalhe", {
          p_operador_email: email,
          p_estado: estado,
          p_limite: POR_PAGINA,
          p_offset: p * POR_PAGINA,
        });
        if (error) throw error;
        if (meu === pedido.current) setDados(d);
      } catch (e) {
        if (meu === pedido.current) setErro(e?.message || String(e));
      } finally {
        if (meu === pedido.current) setCarregando(false);
      }
    },
    [email, estado]
  );

  useEffect(() => {
    carregar(pagina);
  }, [carregar, pagina]);

  const itens = dados?.itens || [];
  const total = Number(dados?.total || 0);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const est = ESTADOS[estado] || ESTADOS.TODOS;

  function fecharFicha() {
    setFichaId(null);
    // Quem abriu a ficha pode ter mexido no acordo (quitar, renegociar):
    // a página atual da lista volta do banco em vez de ficar com o retrato velho.
    carregar(pagina);
  }

  return (
    <div style={S.fundoGaveta} onClick={onFechar}>
      <aside style={S.gaveta} onClick={(e) => e.stopPropagation()}>
        <div style={S.gavetaTopo}>
          <div>
            <h2 style={S.gavetaTitulo}>{nome}</h2>
            <span style={{ ...S.pill, color: est.cor, background: est.fundo }}>{est.rotulo}</span>
            <span style={S.gavetaTotal}>{num(total)} acordos</span>
          </div>
          <button type="button" onClick={onFechar} style={S.fechar} aria-label="Fechar">
            ✕
          </button>
        </div>

        {erro && <div style={S.erro}>{erro}</div>}
        {carregando && <div style={S.vazio}>Carregando…</div>}
        {!carregando && !erro && itens.length === 0 && <div style={S.vazio}>Nenhum acordo neste recorte.</div>}

        {!carregando && itens.length > 0 && (
          <div style={S.rolagem}>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Aluno</th>
                  <th style={S.th}>Ficha com</th>
                  <th style={S.th}>Telefone</th>
                  <th style={S.thNum}>Saldo</th>
                  <th style={S.thNum}>Vencidas</th>
                  <th style={S.thNum}>Vencido</th>
                  <th style={S.thNum}>Atraso</th>
                  <th style={S.thNum}>Próx. venc.</th>
                  <th style={S.thNum}>Últ. acion.</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.acordo_id}>
                    <td style={S.td}>
                      <button
                        type="button"
                        style={i.aluno_id ? S.link : S.linkInerte}
                        onClick={() => setFichaId(i.aluno_id)}
                        disabled={!i.aluno_id}
                        title={i.aluno_id ? "Abrir ficha do aluno" : "Acordo sem aluno vinculado"}
                      >
                        {i.nome || "(sem nome)"}
                      </button>
                      <span style={S.nota}>{i.cpf || ""}</span>
                    </td>
                    <td style={S.td}>
                      {/* Quem cobra a MENSALIDADE desse aluno. Fica explicito
                          quando e outra pessoa -- antes a tela dava a entender
                          que acordo e ficha eram sempre da mesma operadora. */}
                      {i.ficha_responsavel_email
                        ? nomeOperadorPorEmail(i.ficha_responsavel_email)
                        : "sem responsável"}
                    </td>
                    <td style={S.td}>{i.telefone || "—"}</td>
                    <td style={S.tdNum}>{moeda(i.saldo)}</td>
                    <td style={S.tdNum}>{num(i.vencidas)}</td>
                    <td style={S.tdNum}>{moeda(i.valor_vencido)}</td>
                    <td style={S.tdNum}>{i.dias_atraso ? num(i.dias_atraso) + "d" : "—"}</td>
                    <td style={S.tdNum}>{data(i.proximo_vencimento)}</td>
                    <td style={S.tdNum}>{data(i.ultimo_acionamento)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {paginas > 1 && (
          <div style={S.paginacao}>
            <button type="button" style={S.botaoPag} disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>
              ← Anterior
            </button>
            <span style={S.nota}>
              Página {pagina + 1} de {paginas}
            </span>
            <button
              type="button"
              style={S.botaoPag}
              disabled={pagina + 1 >= paginas}
              onClick={() => setPagina((p) => p + 1)}
            >
              Próxima →
            </button>
          </div>
        )}
      </aside>

      {fichaId && (
        // Clique fora fecha só a ficha; o stopPropagation impede que o mesmo
        // clique chegue ao fundo da gaveta e feche a lista junto.
        <div style={A.modalOverlay} onClick={(e) => { e.stopPropagation(); fecharFicha(); }}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button type="button" style={{ ...A.modalFechar, marginLeft: "auto" }} onClick={fecharFicha}>
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

const S = {
  pagina: { padding: 20, maxWidth: 1400, margin: "0 auto" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 18 },
  titulo: { margin: 0, fontSize: 22, fontWeight: 800, color: "var(--rv-tinta)" },
  subtitulo: { margin: "6px 0 0", fontSize: 13.5, color: "var(--rv-texto-suave)", maxWidth: 620 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 },
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 3, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  cardRot: { fontSize: 12, color: "var(--rv-texto-suave)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  cardVal: { fontSize: 21, fontWeight: 800, lineHeight: 1.1 },
  cardNota: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  bloco: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16, padding: 18, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  rolagem: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", color: "var(--rv-texto-fraco)", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 10px", color: "var(--rv-texto-fraco)", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-tinta)" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-tinta)", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  trAlerta: { background: "var(--rv-vermelho-fundo)" },
  trTotal: { fontWeight: 800, background: "var(--rv-fundo-cartao)" },
  nome: { fontWeight: 700 },
  selo: { marginLeft: 7, fontSize: 10, fontWeight: 800, textTransform: "uppercase", color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", borderRadius: 999, padding: "1px 7px" },
  nota: { fontSize: 11, color: "var(--rv-texto-fraco)", marginLeft: 6 },
  botaoNum: { background: "none", border: "none", padding: 0, font: "inherit", fontWeight: 700, cursor: "pointer", textDecoration: "underline", textDecorationColor: "var(--rv-borda-forte)", textUnderlineOffset: 3 },
  trilho: { display: "flex", gap: 2, height: 8, background: "var(--rv-fundo-suave)", borderRadius: 999, overflow: "hidden", minWidth: 120 },
  fatia: { display: "block", height: "100%" },
  legenda: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", fontSize: 12, color: "var(--rv-texto)", margin: "14px 0 0" },
  ponto: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 5, marginLeft: 4 },
  rodape: { fontSize: 12, color: "var(--rv-texto-fraco)", margin: "10px 0 0" },
  vazio: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14, padding: 18, color: "var(--rv-texto-suave)", fontSize: 13.5 },
  erro: { background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho-texto)", borderRadius: 12, padding: 14, fontSize: 13.5, marginBottom: 12 },
  fundoGaveta: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 60 },
  gaveta: { background: "var(--rv-superficie)", width: "min(980px, 96vw)", height: "100%", overflowY: "auto", padding: 20, boxShadow: "-8px 0 32px rgba(15,23,42,0.18)" },
  gavetaTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  gavetaTitulo: { margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: "var(--rv-tinta)" },
  gavetaTotal: { fontSize: 12.5, color: "var(--rv-texto-suave)", marginLeft: 8 },
  pill: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", borderRadius: 999, padding: "2px 9px" },
  fechar: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--rv-texto-suave)", lineHeight: 1 },
  link: { background: "none", border: "none", padding: 0, font: "inherit", color: "var(--rv-azul-texto)", fontWeight: 600, textDecoration: "none", cursor: "pointer", textAlign: "left" },
  linkInerte: { background: "none", border: "none", padding: 0, font: "inherit", color: "var(--rv-texto-suave)", fontWeight: 600, textAlign: "left", cursor: "default" },
  paginacao: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 14 },
  botaoPag: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "6px 12px", fontSize: 13, cursor: "pointer" },
};
