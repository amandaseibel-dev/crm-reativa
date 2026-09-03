import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import BotaoAtualizar from "../components/BotaoAtualizar";

// Acordos vivos por operador: a vencer, vencido e a renegociar.
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

// "Quebrado" não existe no vocabulário da operação: acordo se renegocia.
const ESTADOS = {
  EM_DIA: { rotulo: "Em dia", cor: "#15803d", fundo: "#dcfce7" },
  ATRASADO: { rotulo: "Atrasado", cor: "#b45309", fundo: "#fef3c7" },
  RENEGOCIAR: { rotulo: "A renegociar", cor: "#b91c1c", fundo: "#fee2e2" },
  VENCE_7: { rotulo: "Vence em 7 dias", cor: "#1d4ed8", fundo: "#dbeafe" },
  VENCE_30: { rotulo: "Vence em 30 dias", cor: "#1d4ed8", fundo: "#dbeafe" },
  TODOS: { rotulo: "Todos os acordos", cor: "#334155", fundo: "#e2e8f0" },
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
              rotulo="A renegociar"
              valor={num(totais.a_renegociar)}
              nota={moeda(totais.vencido_renegociar) + " vencidos"}
              cor={ESTADOS.RENEGOCIAR.cor}
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
                    <th style={{ ...S.th, minWidth: 150 }}>Em dia · atrasado · a renegociar</th>
                    <th style={S.thNum}>Em dia</th>
                    <th style={S.thNum}>Atrasados</th>
                    <th style={S.thNum}>A renegociar</th>
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
                            <i style={{ ...S.fatia, width: pct(l.a_renegociar, t), background: ESTADOS.RENEGOCIAR.cor }} />
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
                          <Botao cor={ESTADOS.RENEGOCIAR.cor} onClick={() => setDrill({ email: chave, nome: l.operador_nome, estado: "RENEGOCIAR" })}>
                            {num(l.a_renegociar)}
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
                    <td style={S.tdNum}>{num(totais.a_renegociar)}</td>
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
              <Ponto cor={ESTADOS.RENEGOCIAR.cor} /> A renegociar — 3 ou mais vencidas
            </p>
            <p style={S.rodape}>
              O dono sai do responsável do aluno; quando o aluno não tem, vale o do acordo. A linha
              <b> sem responsável</b> continua visível de propósito: ela é o que a próxima remessa precisa corrigir.
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
      <span style={{ ...S.cardVal, color: cor || "#0f172a" }}>{valor}</span>
      <span style={S.cardNota}>{nota}</span>
    </div>
  );
}

function Botao({ children, onClick, cor }) {
  return (
    <button type="button" onClick={onClick} style={{ ...S.botaoNum, color: cor || "#0f172a" }}>
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
                      <a href={`/aluno?id=${i.aluno_id}`} style={S.link}>
                        {i.nome || "(sem nome)"}
                      </a>
                      <span style={S.nota}>{i.cpf || ""}</span>
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
    </div>
  );
}

const S = {
  pagina: { padding: 20, maxWidth: 1400, margin: "0 auto" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 18 },
  titulo: { margin: 0, fontSize: 22, fontWeight: 800, color: "#0f172a" },
  subtitulo: { margin: "6px 0 0", fontSize: 13.5, color: "#64748b", maxWidth: 620 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 3, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  cardRot: { fontSize: 12, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  cardVal: { fontSize: 21, fontWeight: 800, lineHeight: 1.1 },
  cardNota: { fontSize: 12, color: "#94a3b8" },
  bloco: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  rolagem: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", color: "#94a3b8", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 10px", color: "#94a3b8", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", color: "#0f172a" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", color: "#0f172a", textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  trAlerta: { background: "#fef2f2" },
  trTotal: { fontWeight: 800, background: "#f8fafc" },
  nome: { fontWeight: 700 },
  selo: { marginLeft: 7, fontSize: 10, fontWeight: 800, textTransform: "uppercase", color: "#b91c1c", background: "#fee2e2", borderRadius: 999, padding: "1px 7px" },
  nota: { fontSize: 11, color: "#94a3b8", marginLeft: 6 },
  botaoNum: { background: "none", border: "none", padding: 0, font: "inherit", fontWeight: 700, cursor: "pointer", textDecoration: "underline", textDecorationColor: "#cbd5e1", textUnderlineOffset: 3 },
  trilho: { display: "flex", gap: 2, height: 8, background: "#f1f5f9", borderRadius: 999, overflow: "hidden", minWidth: 120 },
  fatia: { display: "block", height: "100%" },
  legenda: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", fontSize: 12, color: "#475569", margin: "14px 0 0" },
  ponto: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 5, marginLeft: 4 },
  rodape: { fontSize: 12, color: "#94a3b8", margin: "10px 0 0" },
  vazio: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: 18, color: "#64748b", fontSize: 13.5 },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 12, padding: 14, fontSize: 13.5, marginBottom: 12 },
  fundoGaveta: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 60 },
  gaveta: { background: "#fff", width: "min(980px, 96vw)", height: "100%", overflowY: "auto", padding: 20, boxShadow: "-8px 0 32px rgba(15,23,42,0.18)" },
  gavetaTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  gavetaTitulo: { margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: "#0f172a" },
  gavetaTotal: { fontSize: 12.5, color: "#64748b", marginLeft: 8 },
  pill: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", borderRadius: 999, padding: "2px 9px" },
  fechar: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b", lineHeight: 1 },
  link: { color: "#1d4ed8", fontWeight: 600, textDecoration: "none" },
  paginacao: { display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 14 },
  botaoPag: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 13, cursor: "pointer" },
};
