// PAINEL SIMPLES DA CARTEIRA: quatro cards, dois gráficos e o histórico das
// ações — inclusive as que saíram fora do CRM.
//
// A FONTE É UMA SÓ: `preventivo_evolucao`, que devolve um ponto por remessa na
// ordem da EXTRAÇÃO. Cada ponto é a foto daquela data, então nada é somado
// entre ações e nenhum título é contado duas vezes — duas ações sobre a mesma
// remessa não viram o dobro de resultado.
//
// A PALAVRA É "SAIU DA BASE". Sem confirmação de pagamento na fonte, o título
// que deixa de aparecer no relatório seguinte saiu — pode ter sido pagamento,
// cancelamento, bolsa, renegociação ou mudança de recorte.
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from "recharts";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta, dataHora } from "../../utils/preventivoFormato";

const COR_1 = "var(--rv-grafico-1)";
const COR_2 = "var(--rv-grafico-2)";
const EIXO = { fontSize: 11, fill: "var(--rv-texto-fraco)" };

const CONTEXTOS = {
  PROXIMO_VENCIMENTO: "Próximo ao vencimento",
  BOLETO_VENCIDO: "Boleto vencido",
};
const CANAIS = { WHATSAPP: "WhatsApp", EMAIL: "E-mail" };

const compacto = (v) => {
  const n = Number(v || 0);
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
};

function Cartao({ rotulo, valor, sub }) {
  return (
    <div style={{ ...S.card, padding: 16 }}>
      <div style={{ ...S.muted, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {rotulo}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{valor}</div>
      {sub ? <div style={{ ...S.muted, fontSize: 11.5, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

const caixa = {
  background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
  borderRadius: 10, padding: "10px 12px", fontSize: 12.5,
  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
};

function TooltipPonto({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={caixa}>
      <div style={{ fontWeight: 800 }}>{d.nome}</div>
      <div style={{ ...S.muted, fontSize: 11.5, marginBottom: 6 }}>
        extraído em {dataHora(d.extraido_em)}
      </div>
      <Par rot="Títulos em aberto" val={d.titulos} />
      <Par rot="Alunos" val={d.alunos} />
      <Par rot="Saldo" val={moeda(d.saldo)} />
      {d.saiu_da_base_titulos !== null && (
        <>
          <Par rot="Saíram desde a anterior" val={d.saiu_da_base_titulos} />
          <Par rot="Valor que saiu" val={moeda(d.saiu_da_base_valor)} />
        </>
      )}
      {d.entraram ? <Par rot="Entraram" val={d.entraram} /> : null}
    </div>
  );
}

function Par({ rot, val }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14, marginTop: 3 }}>
      <span style={{ color: "var(--rv-texto-fraco)" }}>{rot}</span><strong>{val}</strong>
    </div>
  );
}

export default function EvolucaoDaCarteira({ dados }) {
  if (!dados) return null;
  const pontos = (dados.pontos || []).map((p) => ({ ...p, data: dataCurta(p.extraido_em) }));
  const c = dados.cards || {};

  if (pontos.length === 0) {
    return (
      <div style={{ ...S.card, padding: 22, marginTop: 18 }}>
        <p style={S.muted}>
          Nenhuma remessa importada ainda. A evolução aparece a partir da primeira.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
        <Cartao rotulo="Alunos acionados" valor={c.alunos_acionados ?? 0}
                sub="distintos, em todas as ações com envio" />
        <Cartao rotulo="Saldo inicial" valor={moeda(c.saldo_inicial)}
                sub={`${c.titulos_inicial ?? 0} títulos · ${dataCurta(c.primeira_extracao)}`} />
        <Cartao rotulo="Saldo ainda aberto" valor={moeda(c.saldo_ainda_aberto)}
                sub={`${c.titulos_ainda_abertos ?? 0} títulos · ${dataCurta(c.ultima_extracao)}`} />
        <Cartao rotulo="Saíram da base" valor={c.saiu_da_base_titulos ?? 0}
                sub={`${moeda(c.saiu_da_base_valor)}${c.entraram_depois ? ` · ${c.entraram_depois} entraram depois` : ""}`} />
      </div>

      <p style={{ ...S.muted, marginTop: 10, fontSize: 12 }}>{dados.definicao}</p>

      <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Saldo em aberto por data</h2>
        <div style={{ height: 260, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={pontos} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis dataKey="data" tick={EIXO} />
              <YAxis tick={EIXO} tickFormatter={compacto} />
              <Tooltip content={<TooltipPonto />} />
              <Line type="monotone" dataKey="saldo" stroke={COR_1} strokeWidth={2}
                    dot={{ r: 4, fill: COR_1 }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Títulos em aberto por data</h2>
        <div style={{ height: 260, marginTop: 12 }}>
          <ResponsiveContainer>
            <BarChart data={pontos} margin={{ top: 18, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
              <XAxis dataKey="data" tick={EIXO} />
              <YAxis tick={EIXO} tickFormatter={compacto} />
              <Tooltip content={<TooltipPonto />} cursor={{ fill: "var(--rv-borda-suave)", opacity: 0.35 }} />
              <Bar dataKey="titulos" fill={COR_2} radius={[4, 4, 0, 0]} barSize={46}>
                <LabelList dataKey="titulos" position="top"
                           style={{ fontSize: 11.5, fill: "var(--rv-tinta)" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <HistoricoDasAcoes acoes={dados.acoes || []} />
    </div>
  );
}

// HISTÓRICO: cada ação com o que aconteceu com O PÚBLICO DELA nas remessas
// extraídas depois do envio. O cálculo vem do banco, comparando com a ÚLTIMA
// dessas remessas — assim o título que saiu e voltou aparece como aberto, e
// ninguém é contado duas vezes. Saídas gerais da carteira NÃO entram aqui.
function HistoricoDasAcoes({ acoes }) {
  return (
    <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Histórico das ações</h2>
      <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5 }}>
        Cada linha acompanha <strong>só os títulos que aquela ação incluiu</strong>, comparados
        com a última remessa extraída depois do envio. Ações diferentes não são somadas —
        elas podem conter os mesmos títulos.
      </p>
      {acoes.length === 0 ? (
        <p style={{ ...S.muted, marginTop: 12 }}>Nenhuma ação registrada ainda.</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Ação</th>
                <th style={S.th}>Canal</th>
                <th style={S.th}>Contexto</th>
                <th style={S.th}>Origem</th>
                <th style={S.th}>Enviada em</th>
                <th style={S.th}>Remessa</th>
                <th style={S.th}>Público</th>
                <th style={S.thNum}>Acionados</th>
                <th style={S.thNum}>Saldo acionado</th>
                <th style={S.thNum}>Atualizações</th>
                <th style={S.thNum}>Saíram</th>
                <th style={S.thNum}>Valor que saiu</th>
                <th style={S.thNum}>Em aberto</th>
                <th style={S.thNum}>% títulos</th>
                <th style={S.thNum}>% valor</th>
              </tr>
            </thead>
            <tbody>
              {acoes.map((a) => (
                <tr key={a.id}>
                  <td style={S.td}>{a.nome}</td>
                  <td style={S.td}>{CANAIS[a.canal] || a.canal}</td>
                  <td style={S.td}>{CONTEXTOS[a.contexto] || "—"}</td>
                  <td style={S.td}>{a.origem === "EXTERNA" ? "Fora do CRM" : "Módulo"}</td>
                  <td style={S.td}>{a.enviada_em ? dataHora(a.enviada_em) : "—"}</td>
                  <td style={S.td}>{a.remessa_nome}</td>
                  <td style={S.td}>{a.publico === "lista_informada" ? "Lista" : "Remessa inteira"}</td>
                  <td style={S.td}>{a.base_titulos}</td>
                  <td style={S.td}>{moeda(a.base_saldo)}</td>
                  <td style={S.td}>{a.atualizacoes_depois}</td>
                  <td style={S.td}>{a.saiu_titulos ?? "—"}</td>
                  <td style={S.td}>{a.saiu_valor === null ? "—" : moeda(a.saiu_valor)}</td>
                  <td style={S.td}>{a.em_aberto ?? "—"}</td>
                  <td style={S.td}>{a.taxa_titulos === null ? "—" : `${a.taxa_titulos}%`}</td>
                  <td style={S.td}>{a.taxa_valor === null ? "—" : `${a.taxa_valor}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {acoes.some((a) => a.sem_envio_confirmado) && (
        <p style={{ ...S.muted, marginTop: 10, fontSize: 11.5 }}>
          Ação sem <strong>envio confirmado</strong> não tem resultado: a conta começa no envio.
        </p>
      )}
      {acoes.some((a) => !a.sem_envio_confirmado && a.atualizacoes_depois === 0) && (
        <p style={{ ...S.muted, marginTop: 6, fontSize: 11.5 }}>
          As linhas com “—” tiveram envio, mas ainda não há remessa extraída depois dele.
          Nada é estimado.
        </p>
      )}
    </div>
  );
}
