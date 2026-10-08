// O PAINEL QUE A GESTÃO LÊ SEM TRADUTOR.
//
// Três perguntas, três cards: quanto a carteira tinha quando começamos, quanto
// saiu, quanto está em aberto hoje. Depois a série por data e o que aconteceu
// depois de cada ação.
//
// A PALAVRA É "SAIU DA BASE" — movimento observado entre duas fotos do
// relatório. Não é pagamento confirmado, e nada aqui insinua que seja: a fonte
// não distingue pagamento de cancelamento, bolsa ou renegociação.
//
// O AJUSTE DE SALDO existe porque a conta precisa fechar. Entre duas fotos,
// quem FICA também muda de valor — encargo que correu, pagamento parcial,
// renegociação. Sem uma linha própria, essa diferença acabaria somada em
// "saiu", e aí encargo viraria recuperação. Ela aparece com nome próprio e sem
// classificação, porque a fonte não diz o motivo.
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from "recharts";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta } from "../../utils/preventivoFormato";

const COR_1 = "var(--rv-grafico-1)";
const COR_2 = "var(--rv-grafico-2)";
const EIXO = { fontSize: 11, fill: "var(--rv-texto-fraco)" };
const CANAIS = { WHATSAPP: "WhatsApp", EMAIL: "E-mail" };

const compacto = (v) => {
  const n = Number(v || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
};

const hora = (ts) =>
  new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function Cartao({ rotulo, valor, sub }) {
  return (
    <div style={{ background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-texto-fraco)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {rotulo}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "var(--rv-tinta)", marginTop: 6 }}>{valor}</div>
      {sub ? <div style={{ ...S.muted, fontSize: 12, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}

const caixa = {
  background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
  borderRadius: 10, padding: "10px 12px", fontSize: 12.5,
  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
};

function Dica({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={caixa}>
      <div style={{ fontWeight: 800 }}>{d.rotulo}</div>
      <div style={{ ...S.muted, fontSize: 11.5, marginBottom: 6 }}>{d.nome}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
        <span style={{ color: "var(--rv-texto-fraco)" }}>Títulos</span><strong>{d.titulos}</strong>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, marginTop: 3 }}>
        <span style={{ color: "var(--rv-texto-fraco)" }}>Saldo</span><strong>{moeda(d.saldo)}</strong>
      </div>
    </div>
  );
}

export default function PainelPreventivo({ dados }) {
  if (!dados) return null;
  const c = dados.cards || {};
  const brutos = dados.pontos || [];
  const si = Number(c.inicio?.saldo || 0);
  const pctInicial = si > 0 ? (Number(c.saiu?.valor || 0) / si * 100).toFixed(1) : null;

  if (brutos.length === 0) {
    return (
      <div style={{ ...S.card, padding: 22 }}>
        <p style={S.muted}>Nenhuma remessa importada ainda. O painel aparece a partir da primeira.</p>
      </div>
    );
  }

  // Duas fotos do mesmo dia dariam dois rótulos iguais no eixo. Quando isso
  // acontece, o rótulo ganha a hora declarada ou, sem hora, a ordem no dia.
  const base = brutos.map((p) => ({ ...p, rotulo: dataCurta(p.quando) }));
  const repetida = base.reduce((a, p) => ({ ...a, [p.rotulo]: (a[p.rotulo] || 0) + 1 }), {});
  const pontos = base.map((p) => repetida[p.rotulo] < 2 ? p : {
    ...p,
    rotulo: p.precisao === "DATA_E_HORA"
      ? `${p.rotulo} ${hora(p.quando)}` : `${p.rotulo} (${p.ordem_no_dia}ª)`,
  });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        <Cartao rotulo="Carteira inicial"
                valor={moeda(c.inicio?.saldo)}
                sub={`${c.inicio?.titulos ?? 0} títulos · ${dataCurta(c.inicio?.quando)}`} />
        <Cartao rotulo="Redução observada"
                valor={moeda(c.saiu?.valor)}
                sub={`${c.saiu?.titulos ?? 0} títulos${pctInicial ? ` · ${pctInicial}% do saldo` : ""}`} />
        <Cartao rotulo="Saldo restante"
                valor={moeda(c.hoje?.saldo)}
                sub={`${c.hoje?.titulos ?? 0} títulos · ${dataCurta(c.hoje?.quando)}`} />
      </div>

      <OrdemAmbigua ativa={c.ordem_ambigua} />

      <p style={{ ...S.muted, marginTop: 10, fontSize: 12.5, maxWidth: 880 }}>
        <strong>Redução observada</strong> é movimento observado entre a primeira e a última foto
        do relatório — <strong>não é pagamento confirmado</strong>. A fonte não separa pagamento
        de cancelamento, bolsa ou renegociação.
        {c.alunos_acionados !== null && c.alunos_acionados !== undefined
          ? <> Alunos acionados até aqui: <strong>{c.alunos_acionados}</strong>, contando cada
              aluno uma vez só.</>
          : <> Nenhum envio confirmado ainda — por isso não há alunos acionados a contar.</>}
      </p>

      <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Saldo em aberto por data</h2>
        <div style={{ height: 250, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={pontos} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis dataKey="rotulo" tick={EIXO} />
              <YAxis tick={EIXO} tickFormatter={compacto} />
              <Tooltip content={<Dica />} />
              <Line type="monotone" dataKey="saldo" stroke={COR_1} strokeWidth={2}
                    dot={{ r: 4, fill: COR_1 }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Títulos em aberto por data</h2>
        <div style={{ height: 250, marginTop: 12 }}>
          <ResponsiveContainer>
            <BarChart data={pontos} margin={{ top: 18, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis dataKey="rotulo" tick={EIXO} />
              <YAxis tick={EIXO} tickFormatter={compacto} />
              <Tooltip content={<Dica />} cursor={{ fill: "var(--rv-borda-suave)", opacity: 0.35 }} />
              <Bar dataKey="titulos" fill={COR_2} radius={[4, 4, 0, 0]} barSize={46}>
                <LabelList dataKey="titulos" position="top"
                           style={{ fontSize: 11.5, fill: "var(--rv-tinta)" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <HistoricoPorAcao acoes={dados.acoes || []} consolidado={dados.acoes_consolidado}
                        definicao={dados.definicao} />
    </div>
  );
}

// Os cards saem da PRIMEIRA e da ÚLTIMA foto. Se a ordem entre duas fotos
// vizinhas não está provada, a própria escolha de primeira e última pode ter
// vindo do desempate — e quem lê precisa saber antes de usar o número.
function OrdemAmbigua({ ativa }) {
  if (!ativa) return null;
  return (
    <div style={{ ...S.card, padding: 14, marginTop: 12, borderLeft: "3px solid var(--rv-grafico-2)", borderRadius: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>
        Duas fotos do mesmo dia sem ordem comprovada
      </div>
      <div style={{ ...S.muted, fontSize: 12, marginTop: 4, maxWidth: 880 }}>
        Falta a hora de extração em uma delas, ou as duas têm a mesma ordem no dia. Elas
        aparecem numa ordem estável, mas os cards de início e fim podem depender dessa
        escolha. Informar a ordem no dia, ou a hora, resolve.
      </div>
    </div>
  );
}

// REDUÇÃO DO SALDO APÓS A AÇÃO.
//
// Cada linha compara a foto de onde o envio saiu com a primeira foto
// comprovadamente posterior — e o período fica escrito, para ninguém precisar
// adivinhar o que "depois" significa naquela linha.
//
// AS LINHAS NÃO SE SOMAM. A mesma pessoa pode ter sido acionada por e-mail e
// por WhatsApp, e o título sai uma vez só. Por isso o consolidado vem do banco,
// contando cada título uma vez, em vez de ser a soma da coluna.
function HistoricoPorAcao({ acoes, consolidado, definicao }) {
  const temAjuste = acoes.some((a) => Number(a.ajuste_saldo || 0) !== 0);
  const n = (v) => (v === null || v === undefined ? "—" : v);
  const m = (v) => (v === null || v === undefined ? "—" : moeda(v));
  const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
  const q = (x, prec) => (prec === "DATA_E_HORA" ? `${dataCurta(x)} ${hora(x)}` : dataCurta(x));

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Redução do saldo após a ação</h2>
      <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5, maxWidth: 900 }}>
        Cada linha olha só os títulos que aquele envio incluiu, entre as duas fotos do período.
      </p>

      {acoes.length === 0 ? (
        <p style={{ ...S.muted, marginTop: 12 }}>Nenhum envio registrado ainda.</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Ação</th>
                <th style={S.th}>Canal</th>
                <th style={S.th}>Período comparado</th>
                <th style={S.thNum}>Base</th>
                <th style={S.thNum}>Saldo antes</th>
                <th style={S.thNum}>Redução R$</th>
                <th style={S.thNum}>Redução %</th>
                <th style={S.thNum}>Títulos</th>
                <th style={S.thNum}>% títulos</th>
                {temAjuste && <th style={S.thNum}>Ajuste</th>}
                <th style={S.thNum}>Saldo depois</th>
              </tr>
            </thead>
            <tbody>
              {acoes.map((a) => {
                const pend = Boolean(a.sem_envio_confirmado || a.sequencia_nao_comprovada
                                     || a.aguardando_remessa);
                const p = a.periodo || {};
                return (
                  <tr key={a.id}>
                    <td style={S.td}>
                      {a.nome}
                      {a.origem === "EXTERNA" && (
                        <span style={{ ...S.muted, fontSize: 11, display: "block" }}>fora do CRM</span>
                      )}
                    </td>
                    <td style={S.td}>{CANAIS[a.canal] || a.canal}</td>
                    <td style={S.td}>
                      {p.ate_quando
                        ? `${q(p.de_quando, p.de_precisao)} → ${q(p.ate_quando, p.ate_precisao)}`
                        : "—"}
                    </td>
                    <td style={S.tdNum}>{n(a.antes?.titulos)}</td>
                    <td style={S.tdNum}>{m(a.antes?.saldo)}</td>
                    <td style={S.tdNum}>{pend ? "—" : m(a.reducao?.valor)}</td>
                    <td style={S.tdNum}>{pend ? "—" : pct(a.reducao?.pct_valor)}</td>
                    <td style={S.tdNum}>{pend ? "—" : n(a.reducao?.titulos)}</td>
                    <td style={S.tdNum}>{pend ? "—" : pct(a.reducao?.pct_titulos)}</td>
                    {temAjuste && <td style={S.tdNum}>{pend ? "—" : m(a.ajuste_saldo)}</td>}
                    <td style={S.tdNum}>{pend ? "—" : m(a.depois?.saldo)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {consolidado && consolidado.reducao_titulos !== null
        && consolidado.reducao_titulos !== undefined && (
        <div style={{ ...S.card, padding: 16, marginTop: 14, borderLeft: "3px solid var(--rv-grafico-1)", borderRadius: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Redução atribuível ao conjunto das ações, sem dupla contagem
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 8, alignItems: "baseline" }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{moeda(consolidado.reducao_valor)}</div>
              <div style={{ ...S.muted, fontSize: 11.5 }}>
                de {moeda(consolidado.base_saldo)} acionados
                {consolidado.reducao_pct_valor !== null ? ` · ${consolidado.reducao_pct_valor}%` : ""}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 19, fontWeight: 700 }}>{consolidado.reducao_titulos}</div>
              <div style={{ ...S.muted, fontSize: 11.5 }}>
                de {consolidado.base_titulos} títulos
                {consolidado.reducao_pct_titulos !== null ? ` · ${consolidado.reducao_pct_titulos}%` : ""}
              </div>
            </div>
          </div>
          <div style={{ ...S.muted, fontSize: 11.5, marginTop: 8, maxWidth: 880 }}>
            {consolidado.observacao}
          </div>
        </div>
      )}

      {acoes.some((a) => a.sem_envio_confirmado) && (
        <p style={{ ...S.muted, marginTop: 10, fontSize: 11.5 }}>
          Ação ainda sem envio confirmado não tem o que comparar: a conta começa no envio.
        </p>
      )}
      {acoes.some((a) => a.aguardando_remessa) && (
        <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5 }}>
          Onde há “—”, o envio aconteceu mas ainda não veio uma remessa depois dele. Nada é
          estimado.
        </p>
      )}
      {acoes.some((a) => a.sequencia_nao_comprovada) && (
        <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5 }}>
          Há remessa do mesmo dia do envio sem hora comprovada dos dois lados. Sem saber o que
          veio antes, o resultado fica pendente até a próxima foto.
        </p>
      )}
      {temAjuste && (
        <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5, maxWidth: 900 }}>
          <strong>Ajuste</strong> é a variação de valor dos títulos que continuam nas duas
          fotos — encargo, pagamento parcial, renegociação. Existe para a conta fechar e{" "}
          <strong>não é recuperação</strong>.
        </p>
      )}
      <p style={{ ...S.muted, marginTop: 10, fontSize: 11.5, maxWidth: 900 }}>{definicao}</p>
    </div>
  );
}
