// O PAINEL QUE A GESTÃO LÊ SEM TRADUTOR.
//
// A VISÃO PRINCIPAL responde três perguntas e para: quanto a carteira tinha
// quando começamos, quanto ela caiu de lá para cá, e quanto ainda está em
// aberto. Embaixo, a linha do tempo: o que mudou entre uma foto e a seguinte,
// com as ações do período ao lado.
//
// POR QUE A REDUÇÃO AQUI É A LÍQUIDA (saldo inicial − saldo da última foto) e
// não a soma do que "saiu": entre duas fotos também ENTRA título novo e muda o
// valor de quem fica. Só a líquida fecha com o saldo que a operação enxerga
// hoje. A decomposição — saiu, entradas, ajuste — continua visível em cada
// intervalo, para que a conta possa ser conferida em vez de aceita.
//
// OS INTERVALOS NÃO SE SOBREPÕEM, e por isso somam. Já os resultados por
// público se sobrepõem (a mesma pessoa é acionada por dois canais) e por isso
// vivem em "Ver detalhes", junto do consolidado que conta cada título uma vez.
//
// A PALAVRA É "REDUÇÃO OBSERVADA" — movimento entre duas fotos do relatório.
// Não é pagamento confirmado, não é recuperação comprovada, e o percentual em
// aberto NÃO é inadimplência geral da instituição: é o que resta desta
// carteira. A fonte não distingue pagamento de cancelamento, bolsa ou
// renegociação, e a ordem das remessas nunca vira horário inventado nem prova
// de que a redução veio de uma ação.
//
// O AJUSTE DE SALDO existe porque a conta precisa fechar. Entre duas fotos,
// quem FICA também muda de valor — encargo que correu, pagamento parcial,
// renegociação. Sem uma linha própria, essa diferença acabaria somada em
// "saiu", e aí encargo viraria recuperação. Ela aparece com nome próprio e sem
// classificação, porque a fonte não diz o motivo.
import { useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, LabelList,
} from "recharts";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta, pct, moedaEm, SEM_MOEDA } from "../../utils/preventivoFormato";

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

export default function PainelPreventivo({ dados, intervalos, aoMudarCusto }) {
  if (!dados) return null;
  const c = dados.cards || {};
  const brutos = dados.pontos || [];
  const si = Number(c.inicio?.saldo || 0);
  const sh = Number(c.hoje?.saldo || 0);
  // REDUÇÃO LÍQUIDA: o que a carteira perdeu de ponta a ponta, já com entradas
  // e ajustes dentro. É a única leitura que fecha com o saldo de hoje.
  const liquida = si - sh;
  const pctLiquida = si > 0 ? liquida / si * 100 : null;
  const pctAberto = si > 0 ? sh / si * 100 : null;

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
        <Cartao rotulo="Redução líquida da carteira"
                valor={moeda(liquida)}
                sub={`${pctLiquida !== null ? `${pct(pctLiquida)} do saldo inicial · ` : ""}`
                     + `${(c.inicio?.titulos ?? 0) - (c.hoje?.titulos ?? 0)} títulos a menos`} />
        <Cartao rotulo="Saldo ainda em aberto"
                valor={moeda(c.hoje?.saldo)}
                sub={`${c.hoje?.titulos ?? 0} títulos`
                     + `${pctAberto !== null ? ` · ${pct(pctAberto)} do saldo inicial` : ""}`} />
      </div>

      <OrdemAmbigua ativa={c.ordem_ambigua} />

      <div style={{ ...S.muted, fontSize: 12.5, marginTop: 8 }}>
        Atualizado pelo relatório de <strong>{dataCurta(c.hoje?.quando)}</strong>.
      </div>

      <p style={{ ...S.muted, marginTop: 10, fontSize: 12.5, maxWidth: 880 }}>
        <strong>Redução observada</strong> entre a primeira e a última foto do relatório —
        <strong> não é pagamento confirmado nem recuperação comprovada</strong>. A fonte não
        separa pagamento de cancelamento, bolsa ou renegociação. O percentual em aberto é o
        que resta <em>desta carteira</em>, e não a inadimplência geral.
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

      <LinhaDoTempo intervalos={intervalos} />

      <Detalhes rotulo="Ver detalhes por público e consolidado">
        <div style={{ ...S.card, padding: 20 }}>
          <h3 style={{ ...S.cardNome, fontSize: 15, margin: 0 }}>Títulos em aberto por data</h3>
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
                          definicao={dados.definicao} aoMudarCusto={aoMudarCusto} />
      </Detalhes>
    </div>
  );
}

// "Ver detalhes" é um <details> de verdade: fecha por padrão, abre com teclado
// e não precisa de estado. O que mora aqui é o que NÃO soma — resultado por
// público, que se sobrepõe — e o consolidado que corrige essa sobreposição.
function Detalhes({ rotulo, children }) {
  return (
    <details style={{ marginTop: 18 }}>
      <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 700,
                        color: "var(--rv-tinta)", padding: "6px 0" }}>
        {rotulo}
      </summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}

// A LINHA DO TEMPO, por INTERVALO entre remessas consecutivas.
//
// Cada linha cobre um período e só um: os intervalos são disjuntos, então os
// líquidos somam e fecham com a redução do topo. As ações aparecem ao lado do
// período em que caíram — ao lado, não como causa: a fonte não diz por que o
// título saiu, e duas ações no mesmo intervalo não se dividem o resultado.
function LinhaDoTempo({ intervalos }) {
  if (!intervalos) return null;
  if (intervalos.length === 0) {
    return (
      <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Linha do tempo</h2>
        <p style={{ ...S.muted, fontSize: 12.5, marginTop: 8, marginBottom: 0 }}>
          Só há uma remessa até aqui. A linha do tempo começa na segunda, quando existe um
          período para comparar.
        </p>
      </div>
    );
  }

  const q = (x, prec) => (prec === "DATA_E_HORA" ? `${dataCurta(x)} ${hora(x)}` : dataCurta(x));

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Linha do tempo</h2>
      <p style={{ ...S.muted, fontSize: 12.5, marginTop: 6, maxWidth: 900 }}>
        Um período por linha, sem sobreposição — por isso os líquidos somam e fecham com a
        redução do topo. As ações listadas aconteceram <strong>dentro</strong> do período;
        isso não atribui a redução a elas.
      </p>

      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        {intervalos.map((i) => <Intervalo key={`${i.de?.remessa}-${i.ate?.remessa}`} i={i} q={q} />)}
      </div>
    </div>
  );
}

function Intervalo({ i, q }) {
  const liquido = Number(i.liquido || 0);
  const caiu = liquido <= 0;
  return (
    <div style={{ border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline",
                    justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>
            {q(i.de?.quando, i.de?.precisao)} → {q(i.ate?.quando, i.ate?.precisao)}
          </div>
          <div style={{ ...S.muted, fontSize: 11.5, marginTop: 2 }}>
            {i.de?.nome} → {i.ate?.nome}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 20, fontWeight: 800 }}>
            {caiu ? "−" : "+"}{moeda(Math.abs(liquido)).replace("R$", "R$")}
          </div>
          <div style={{ ...S.muted, fontSize: 11.5 }}>
            {i.pct_saldo === null || i.pct_saldo === undefined
              ? "variação líquida no período"
              : `${pct(Math.abs(Number(i.pct_saldo)))} do saldo no início do período`}
          </div>
        </div>
      </div>

      <div style={{ ...S.muted, fontSize: 11.5, marginTop: 8 }}>
        {moeda(i.antes?.saldo)} ({i.antes?.titulos} títulos) → {moeda(i.depois?.saldo)}{" "}
        ({i.depois?.titulos} títulos) · saíram {i.saiu?.titulos} ({moeda(i.saiu?.valor)}) ·
        {" "}entraram {i.entradas?.titulos} ({moeda(i.entradas?.valor)}) · ajuste de saldo{" "}
        {moeda(i.ajuste)}
      </div>

      {i.ordem_comprovada === false && (
        <div style={{ ...S.muted, fontSize: 11.5, marginTop: 6 }}>
          Fotos do mesmo dia sem hora comprovada: a ordem entre elas não está provada.
        </div>
      )}

      {i.acoes?.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--rv-borda)",
                      display: "grid", gap: 6 }}>
          {i.acoes.map((a) => (
            <div key={a.id} style={{ fontSize: 12.5 }}>
              <strong>{a.nome}</strong>
              <span style={S.muted}>
                {" · "}{CANAIS[a.canal] || a.canal}
                {" · "}{q(a.quando, a.precisao)}
                {" · "}{a.custo_informado
                  ? `custo ${moedaEm(a.custo_total, a.custo_moeda)}`
                    + (a.custo_moeda ? "" : ` (${SEM_MOEDA})`)
                  : "custo não informado"}
              </span>
            </div>
          ))}
        </div>
      )}
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

// REDUÇÃO OBSERVADA APÓS A AÇÃO.
//
// "Após", não "por causa de". Cada card mostra o que mudou no período entre a
// foto de onde o envio saiu e a primeira foto comprovadamente posterior — e o
// período fica escrito. A fonte não distingue pagamento de cancelamento, bolsa
// ou renegociação, então nada aqui atribui a saída ao envio.
//
// AS LINHAS NÃO SE SOMAM. A mesma pessoa acionada por dois canais sai uma vez
// só. O consolidado vem do banco, conta cada título uma vez e, por olhar a
// ÚLTIMA foto, enxerga reentrada — título que saiu e voltou não conta.
//
// CUSTO fica ao lado do resultado, nunca dentro dele: não desconta do saldo e
// não vira ROI. Quem lê decide.
function HistoricoPorAcao({ acoes, consolidado, definicao, aoMudarCusto }) {
  const n = (v) => (v === null || v === undefined ? "—" : v);
  const m = (v) => (v === null || v === undefined ? "—" : moeda(v));
  const q = (x, prec) => (prec === "DATA_E_HORA" ? `${dataCurta(x)} ${hora(x)}` : dataCurta(x));
  const pendente = (a) => Boolean(a.sem_envio_confirmado || a.sequencia_nao_comprovada
                                  || a.aguardando_remessa);

  const barras = acoes
    .filter((a) => !pendente(a) && a.reducao?.valor !== null && a.reducao?.valor !== undefined)
    .map((a) => ({
      // Nome INTEIRO: as barras são horizontais justamente para que
      // "E-mail de 05/10 (manhã)" caiba sem virar "E-mail de 05/10 (manh…".
      rotulo: a.nome,
      valor: Number(a.reducao.valor), pct: Number(a.reducao.pct_valor ?? 0),
      titulos: a.reducao.titulos, nome: a.nome,
    }));

  return (
    <div style={{ marginTop: 16 }}>
      <h2 style={{ ...S.cardNome, fontSize: 16, margin: "0 0 6px" }}>Redução observada após a ação</h2>
      <p style={{ ...S.muted, fontSize: 12.5, maxWidth: 900, marginTop: 0 }}>
        Movimento no período entre as duas fotos indicadas em cada card. <strong>Não é efeito
        comprovado do envio</strong> — a fonte não diz por que o título saiu.
      </p>

      {acoes.length === 0 ? (
        <p style={{ ...S.muted, marginTop: 12 }}>Nenhum envio registrado ainda.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 12 }}>
          {acoes.map((a) => (
            <CartaoAcao key={a.id} a={a} pendente={pendente(a)} n={n} m={m} q={q}
                        aoMudarCusto={aoMudarCusto} />
          ))}
        </div>
      )}

      {barras.length > 0 && (
        <div style={{ ...S.card, padding: 20, marginTop: 16 }}>
          <h3 style={{ ...S.cardNome, fontSize: 14, margin: 0 }}>Redução por ação, em reais</h3>
          <div style={{ height: Math.max(150, barras.length * 54 + 44), marginTop: 12 }}>
            <ResponsiveContainer>
              <BarChart layout="vertical" data={barras}
                        margin={{ top: 8, right: 58, left: 4, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke="var(--rv-borda-suave)" strokeDasharray="3 3" />
                <XAxis type="number" tick={EIXO} tickFormatter={compacto} />
                <YAxis type="category" dataKey="rotulo" tick={EIXO} width={200} interval={0} />
                <Tooltip content={<DicaBarra />} cursor={{ fill: "var(--rv-borda-suave)", opacity: 0.35 }} />
                <Bar dataKey="valor" fill={COR_1} radius={[0, 4, 4, 0]} barSize={26}>
                  <LabelList dataKey="pct" position="right" formatter={pct}
                             style={{ fontSize: 11.5, fill: "var(--rv-tinta)" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p style={{ ...S.muted, marginTop: 8, fontSize: 11.5 }}>
            As barras não se somam — veja o consolidado abaixo.
          </p>
        </div>
      )}

      {consolidado && (
        <div style={{ ...S.card, padding: 16, marginTop: 14, borderLeft: "3px solid var(--rv-grafico-1)", borderRadius: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Consolidado das ações, sem dupla contagem
          </div>
          {consolidado.reducao_titulos === null || consolidado.reducao_titulos === undefined ? (
            <div style={{ ...S.muted, fontSize: 12.5, marginTop: 6 }}>
              Pendente: {consolidado.pendentes_titulos ?? 0} títulos acionados ainda não têm
              remessa posterior para comparar. Nada é estimado.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 8, alignItems: "baseline" }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{moeda(consolidado.reducao_valor)}</div>
                  <div style={{ ...S.muted, fontSize: 11.5 }}>
                    de {moeda(consolidado.base_saldo)} acionados
                    {consolidado.reducao_pct_valor !== null ? ` · ${pct(consolidado.reducao_pct_valor)}` : ""}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 700 }}>{consolidado.reducao_titulos}</div>
                  <div style={{ ...S.muted, fontSize: 11.5 }}>
                    de {consolidado.com_regua_titulos} títulos comparáveis
                    {consolidado.reducao_pct_titulos !== null ? ` · ${pct(consolidado.reducao_pct_titulos)}` : ""}
                  </div>
                </div>
                {/* UM BLOCO POR MOEDA. Somar BRL com USD num número só seria
                    inventar câmbio — e esconder o erro dentro do total. */}
                {(consolidado.custos_por_moeda || []).map((c) => (
                  <div key={c.moeda}>
                    <div style={{ fontSize: 19, fontWeight: 700 }}>
                      {moedaEm(c.total, c.moeda === "NAO_INFORMADA" ? null : c.moeda)}
                    </div>
                    <div style={{ ...S.muted, fontSize: 11.5 }}>
                      custo informado{c.moeda === "NAO_INFORMADA" ? ` (${SEM_MOEDA})` : ""}
                    </div>
                  </div>
                ))}
              </div>
              {consolidado.pendentes_titulos > 0 && (
                <div style={{ ...S.muted, fontSize: 11.5, marginTop: 6 }}>
                  Fora da conta: {consolidado.pendentes_titulos} títulos acionados sem remessa
                  posterior — pendentes, não zero.
                </div>
              )}
            </>
          )}
          <div style={{ ...S.muted, fontSize: 11.5, marginTop: 8, maxWidth: 900 }}>
            {consolidado.observacao}
          </div>
        </div>
      )}

      <p style={{ ...S.muted, marginTop: 10, fontSize: 11.5, maxWidth: 900 }}>{definicao}</p>
    </div>
  );
}

function DicaBarra({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={caixa}>
      <div style={{ fontWeight: 800 }}>{d.nome}</div>
      <div style={{ marginTop: 4 }}>{moeda(d.valor)} · {pct(d.pct)}</div>
      <div style={{ ...S.muted, fontSize: 11.5 }}>{d.titulos} títulos</div>
    </div>
  );
}

// Um card por ação: o valor grande, o percentual, os títulos e o período.
// O custo é editável aqui mesmo — informar depois é o caso normal.
function CartaoAcao({ a, pendente, n, m, q, aoMudarCusto }) {
  const p = a.periodo || {};
  const motivo = a.sem_envio_confirmado ? "sem envio confirmado"
    : a.sequencia_nao_comprovada ? "ordem do mesmo dia não comprovada"
    : "aguardando a próxima remessa";

  return (
    <div style={{ ...S.card, padding: 18 }}>
      <div style={{ ...S.cardNome, fontSize: 14 }}>{a.nome}</div>
      <div style={{ ...S.muted, fontSize: 11.5, marginTop: 2 }}>
        {CANAIS[a.canal] || a.canal}
        {a.origem === "EXTERNA" ? " · fora do CRM" : ""}
        {p.ate_quando
          ? ` · ${q(p.de_quando, p.de_precisao)} → ${q(p.ate_quando, p.ate_precisao)}`
          : ""}
      </div>

      {pendente ? (
        <div style={{ ...S.muted, fontSize: 12.5, marginTop: 14 }}>
          Resultado pendente — {motivo}. Nada é estimado.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 12 }}>{m(a.reducao?.valor)}</div>
          <div style={{ ...S.muted, fontSize: 12.5, marginTop: 2 }}>
            {a.reducao?.pct_valor !== null && a.reducao?.pct_valor !== undefined
              ? `${pct(a.reducao.pct_valor)} do saldo acionado` : "—"}
            {" · "}{n(a.reducao?.titulos)} de {n(a.antes?.titulos)} títulos
            {a.reducao?.pct_titulos !== null && a.reducao?.pct_titulos !== undefined
              ? ` (${pct(a.reducao.pct_titulos)})` : ""}
          </div>
        </>
      )}

      <Custo a={a} aoMudar={aoMudarCusto} />
    </div>
  );
}

function Custo({ a, aoMudar }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(a.custo?.total ?? "");
  const [m, setM] = useState(a.custo?.moeda ?? "BRL");
  const [erro, setErro] = useState("");
  const alunos = a.antes?.alunos ?? 0;

  async function salvar() {
    const txt = String(v).trim();
    const num = txt === "" ? null : Number(txt.replace(",", "."));
    if (num !== null && (Number.isNaN(num) || num < 0)) {
      setErro("Informe um valor igual ou maior que zero, ou deixe em branco."); return;
    }
    setErro("");
    const ok = await aoMudar?.(a.id, num, num === null ? null : m);
    if (ok) setEdit(false);
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed var(--rv-borda)" }}>
      {!edit ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <div style={{ ...S.muted, fontSize: 12 }}>
            {a.custo?.informado ? (
              <>
                Custo <strong>{moedaEm(a.custo.total, a.custo.moeda)}</strong>
                {a.custo.moeda ? null : <> ({SEM_MOEDA})</>}
                {a.custo.por_aluno !== null && a.custo.por_aluno !== undefined
                  ? <> · <strong>{moedaEm(a.custo.por_aluno, a.custo.moeda)}</strong> por aluno
                      acionado ({alunos} alunos)</>
                  : null}
              </>
            ) : "Custo não informado"}
          </div>
          <button style={{ ...S.btnGhost, padding: "2px 10px", fontSize: 12 }}
                  onClick={() => { setV(a.custo?.total ?? ""); setEdit(true); }}>
            {a.custo?.informado ? "Editar" : "Informar"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="number" min="0" step="0.01" value={v} placeholder="Custo total"
                 style={{ ...S.input, maxWidth: 140 }}
                 onChange={(e) => setV(e.target.value)} />
          <select value={m} style={{ ...S.input, maxWidth: 110 }}
                  onChange={(e) => setM(e.target.value)}>
            <option value="BRL">R$ (BRL)</option>
            <option value="USD">US$ (USD)</option>
          </select>
          <button style={{ ...S.btnGhost, padding: "4px 12px" }} onClick={salvar}>Salvar</button>
          <button style={{ ...S.btnGhost, padding: "4px 12px" }}
                  onClick={() => { setEdit(false); setErro(""); }}>Cancelar</button>
          {erro && <span style={{ color: "var(--rv-erro)", fontSize: 11.5 }}>{erro}</span>}
        </div>
      )}
    </div>
  );
}
