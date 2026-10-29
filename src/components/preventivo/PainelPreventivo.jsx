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
        <Cartao rotulo="Total da carteira quando iniciamos"
                valor={moeda(c.inicio?.saldo)}
                sub={`${c.inicio?.titulos ?? 0} títulos · ${dataCurta(c.inicio?.quando)}`} />
        <Cartao rotulo="Saíram da base"
                valor={c.saiu?.titulos ?? 0}
                sub={moeda(c.saiu?.valor)} />
        <Cartao rotulo="Saldo em aberto hoje"
                valor={moeda(c.hoje?.saldo)}
                sub={`${c.hoje?.titulos ?? 0} títulos · ${dataCurta(c.hoje?.quando)}`} />
      </div>

      <OrdemAmbigua ativa={c.ordem_ambigua} />

      <p style={{ ...S.muted, marginTop: 10, fontSize: 12.5, maxWidth: 880 }}>
        <strong>Saíram da base</strong> é movimento observado entre a primeira e a última foto
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

      <HistoricoPorAcao acoes={dados.acoes || []} definicao={dados.definicao} />
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

// O que aconteceu DEPOIS de cada ação, com a conta fechando na horizontal:
// antes − saiu + entradas + ajuste = depois.
function HistoricoPorAcao({ acoes, definicao }) {
  const temAjuste = acoes.some((a) => Number(a.ajuste_saldo || 0) !== 0);
  return (
    <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>O que mudou depois de cada ação</h2>
      <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5, maxWidth: 880 }}>
        Cada linha compara a foto de onde o envio saiu com a primeira foto seguinte. Ações
        diferentes não se somam — elas podem conter os mesmos títulos.
      </p>

      {acoes.length === 0 ? (
        <p style={{ ...S.muted, marginTop: 12 }}>Nenhuma ação registrada ainda.</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Ação</th>
                <th style={S.th}>Data</th>
                <th style={S.th}>Canal</th>
                <th style={S.thNum}>Títulos antes</th>
                <th style={S.thNum}>Saldo antes</th>
                <th style={S.thNum}>Saíram</th>
                <th style={S.thNum}>Valor que saiu</th>
                <th style={S.thNum}>Entradas</th>
                {temAjuste && <th style={S.thNum}>Ajuste de saldo</th>}
                <th style={S.thNum}>Títulos depois</th>
                <th style={S.thNum}>Saldo depois</th>
              </tr>
            </thead>
            <tbody>
              {acoes.map((a) => {
                const pend = a.sem_envio_confirmado ? "sem envio confirmado"
                  : a.sequencia_nao_comprovada ? "ordem não comprovada"
                  : a.aguardando_remessa ? "aguardando a próxima remessa" : null;
                const n = (v) => (v === null || v === undefined ? "—" : v);
                const m = (v) => (v === null || v === undefined ? "—" : moeda(v));
                return (
                  <tr key={a.id}>
                    <td style={S.td}>
                      {a.nome}
                      {a.origem === "EXTERNA" && (
                        <span style={{ ...S.muted, fontSize: 11, display: "block" }}>fora do CRM</span>
                      )}
                    </td>
                    <td style={S.td}>{a.quando ? dataCurta(a.quando) : "—"}</td>
                    <td style={S.td}>{CANAIS[a.canal] || a.canal}</td>
                    <td style={S.tdNum}>{n(a.antes?.titulos)}</td>
                    <td style={S.tdNum}>{m(a.antes?.saldo)}</td>
                    <td style={S.tdNum}>{pend ? "—" : n(a.saiu?.titulos)}</td>
                    <td style={S.tdNum}>{pend ? "—" : m(a.saiu?.valor)}</td>
                    <td style={S.tdNum}>{pend ? "—" : n(a.entradas?.titulos)}</td>
                    {temAjuste && <td style={S.tdNum}>{pend ? "—" : m(a.ajuste_saldo)}</td>}
                    <td style={S.tdNum}>{pend ? "—" : n(a.depois?.titulos)}</td>
                    <td style={S.tdNum}>{pend ? "—" : m(a.depois?.saldo)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
        <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5, maxWidth: 880 }}>
          <strong>Ajuste de saldo</strong> é a variação de valor dos títulos que continuam nas
          duas fotos — encargo, pagamento parcial, renegociação. Ele existe para a conta fechar
          e <strong>não é recuperação</strong>: a fonte não informa o motivo.
        </p>
      )}
      <p style={{ ...S.muted, marginTop: 10, fontSize: 11.5, maxWidth: 880 }}>{definicao}</p>
    </div>
  );
}
