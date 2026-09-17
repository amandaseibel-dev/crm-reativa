import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

// EFETIVIDADE DA COBRANÇA — visão executiva, um layout só para toda safra.
//
// O que muda entre 2024, 2025, 2026/1 e 2026/2 é o DADO e o CONCEITO do
// período, nunca o desenho da página. Em qualquer safra a Diretoria encontra,
// sempre no mesmo lugar: quanto há em carteira, quantos alunos são, quanto foi
// convertido, quanto entrou em dinheiro, a situação atual e o perfil dos alunos.
//
// Três naturezas de período, cada uma com a régua que os dados permitem:
//   CARTEIRA CONSOLIDADA (2026/1) — safra fechada; as quatro faixas somam 100%.
//   SEMESTRE VIGENTE (2026/2)     — em curso; só o que já foi negociado. Sem
//                                   inadimplência: há título a vencer.
//   COBERTURA HISTÓRICA (2024/25) — o CRM não guarda nada anterior a julho/2026,
//                                   então não há percentual de efetividade: o
//                                   que existe é o saldo residual e o que foi
//                                   convertido desde a entrada em cobrança.
//
// Nenhuma conta acontece aqui. Os valores vêm prontos das RPCs; o front só
// desenha. Detalhe por CPF/título existe no banco, mas fora da visão executiva.

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const moedaCurta = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return "R$ " + (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
  if (Math.abs(n) >= 1e3) return "R$ " + (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
  return moeda(n);
};
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const data = (v) => (v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—");
const pctTexto = (parte, todo, casas = 2) =>
  Number(todo) > 0
    ? (Number(parte) / Number(todo) * 100).toLocaleString("pt-BR",
        { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%"
    : "—";

// ---------------------------------------------------------------- LIBERAÇÃO
// Enquanto a área está sendo finalizada, só a Amanda vê os indicadores. Angela,
// Gustavo e o resto da diretoria entram pelo menu normalmente e encontram a
// tela "Em breve" — é preparação de funcionalidade, não bloqueio de segurança
// (a autorização de verdade segue nas RPCs, que já são de gestão + diretoria).
//
// PARA LIBERAR PARA TODA A DIRETORIA: troque o corpo de `podeVerIndicadores`
// por `return true`. Nada mais na página precisa mudar.
const EMAILS_COM_ACESSO_TOTAL = ["amanda.seibel@aelbra.com.br"];
function podeVerIndicadores(email) {
  return EMAILS_COM_ACESSO_TOTAL.includes(String(email || "").toLowerCase().trim());
}

// Cores por PAPEL, sempre em token: o tema escuro troca o valor de cada token e
// a tela acompanha sem mudar JSX. Hex fixo aqui reprovava no escuro — o verde
// #1f7a3d e o vermelho #b4232a ficavam ilegíveis sobre fundo escuro.
const AZUL = "var(--rv-azul)", VERDE = "var(--rv-verde-ok)", VERMELHO = "var(--rv-vermelho)",
      AMBAR = "var(--rv-ambar)", CINZA = "var(--rv-texto-suave)";

export default function CarteiraEfetividade() {
  const [ano, setAno] = useState("2026");
  const [sem, setSem] = useState("1");
  const [consolidada, setConsolidada] = useState(null);
  const [academico, setAcademico] = useState(null);
  const [vigente, setVigente] = useState(null);
  const [contexto, setContexto] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [metodologia, setMetodologia] = useState(false);
  const [obraAberta, setObraAberta] = useState(false);
  const [email, setEmail] = useState(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data: sessao } = await supabase.auth.getUser();
      const quem = sessao?.user?.email || "";
      if (!ativo) return;
      if (!podeVerIndicadores(quem)) { setEmail(quem); setCarregando(false); return; }
      const [a, b, c, e, f] = await Promise.all([
        supabase.rpc("carteira_2026_1_indicadores"),
        supabase.rpc("carteira_2026_1_academico"),
        supabase.rpc("carteira_2026_2_negociacoes"),
        supabase.rpc("carteira_2026_2_contexto"),
        supabase.rpc("carteira_saldo_historico_por_ano"),
      ]);
      if (!ativo) return;
      const primeiro = [a, b, c, e, f].find((r) => r.error);
      if (primeiro) setErro(primeiro.error.message);
      setConsolidada(a.data?.vazio ? null : a.data);
      setAcademico(b.data || null);
      setVigente(c.data || null);
      setContexto(e.data || null);
      setHistorico(f.data || null);
      setEmail(quem);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <Carregando />;

  if (!podeVerIndicadores(email)) {
    return (
      <div style={S.pagina}>
        <h1 style={S.h1}>Efetividade</h1>
        <div style={S.emBreve}>
          <span style={{ fontSize: 30, lineHeight: 1 }} aria-hidden="true">🧭</span>
          <strong style={{ fontSize: 20, fontWeight: 700 }}>Em breve</strong>
          <p style={{ margin: 0, fontSize: 14, color: "var(--rv-texto-suave)", lineHeight: 1.6, maxWidth: 520 }}>
            Estamos finalizando esta nova área de acompanhamento da efetividade da cobrança. Em breve os indicadores
            estarão disponíveis para consulta.
          </p>
        </div>
      </div>
    );
  }

  // 2024 e 2025 são lidos por ANO (os dois semestres unificados); só 2026 tem
  // semestre, porque só ali o semestre muda a natureza do período.
  const safra = ano + "/" + sem;
  const periodo = ano === "2026" ? safra : ano;
  const natureza = safra === "2026/1" ? "Carteira consolidada"
                 : safra === "2026/2" ? "Semestre vigente" : "Cobertura histórica";

  // ---- os quatro indicadores, a situação e o rodapé de cada natureza de período
  let indicadores = [], situacao = [], referencia = 0, rodape = null, tituloSituacao = "Situação da carteira";
  // O que é 100% na barra muda com a natureza do período; dizer qual é a base
  // evita a leitura errada de um percentual sem denominador declarado.
  let referenciaRotulo = "";

  if (safra === "2026/1" && consolidada) {
    const base = Number(consolidada.base?.valor || 0);
    const f = consolidada.faixas || {};
    referencia = base;
    indicadores = [
      { rotulo: "Carteira convertida", valor: moedaCurta(f.efetividade), apoio: pctTexto(f.efetividade, base), cor: AZUL },
      { rotulo: "Valor recebido", valor: moedaCurta(consolidada.recuperacao?.total), apoio: pctTexto(consolidada.recuperacao?.total, base), cor: VERDE },
      { rotulo: "Alunos da carteira", valor: num(consolidada.base?.cpfs) + " alunos", apoio: num(consolidada.base?.titulos) + " títulos", cor: "var(--rv-tinta)" },
      { rotulo: "Em aberto sem negociação", valor: moedaCurta(f.inadimplencia), apoio: pctTexto(f.inadimplencia, base), cor: VERMELHO },
    ];
    situacao = [
      { rotulo: "Convertido", valor: f.efetividade, cor: AZUL },
      { rotulo: "Em aberto sem negociação", valor: f.inadimplencia, cor: VERMELHO },
      { rotulo: "Em conferência", valor: f.em_validacao, cor: AMBAR },
      { rotulo: "Ajuste acadêmico", valor: f.academico, cor: CINZA },
    ];
    referenciaRotulo = "da carteira congelada";
    rodape = "Carteira de " + moeda(base) + " · congelada em " + data(consolidada.base?.congelada_em)
           + " · fotografia de " + data(consolidada.gerado_em);
  }

  if (safra === "2026/2" && vigente) {
    const t = vigente.total || {};
    referencia = Number(t.negociado || 0);
    indicadores = [
      { rotulo: "Valor negociado", valor: moedaCurta(t.negociado), apoio: num(t.titulos) + " títulos negociados", cor: AZUL },
      { rotulo: "Valor recebido", valor: moedaCurta(t.recebido), apoio: pctTexto(t.recebido, t.negociado, 1) + " do negociado", cor: VERDE },
      { rotulo: "Alunos negociados", valor: num(t.cpfs) + " alunos", apoio: num(t.acordos) + " acordos", cor: "var(--rv-tinta)" },
      { rotulo: "Saldo negociado", valor: moedaCurta(t.saldo), apoio: "ainda a receber", cor: AMBAR },
    ];
    const CORES = { "Quitado": VERDE, "Regular": AZUL, "Em atraso": AMBAR, "Acordo quebrado": VERMELHO, "Acordo cancelado": CINZA };
    const NOMES = { "Acordo quebrado": "Quebrado", "Acordo cancelado": "Cancelado" };
    situacao = (vigente.estados || []).map((e) => ({
      rotulo: NOMES[e.estado] || e.estado, valor: e.negociado, cor: CORES[e.estado] || AZUL,
    }));
    referenciaRotulo = "do valor negociado";
    rodape = "Carteira recebida: " + moedaCurta(contexto?.carteira_valor) + " · "
           + num(contexto?.carteira_titulos) + " títulos · " + num(contexto?.carteira_cpfs) + " alunos · "
           + num(contexto?.remessas) + " remessas (" + data(contexto?.primeira_remessa) + " a "
           + data(contexto?.ultima_remessa) + ")";
  }

  const hist = ano !== "2026" ? (historico?.anos || []).find((x) => x.ano === ano) : null;
  if (hist) {
    const aberto = hist.aberto || {}, carteira = hist.carteira || {};
    referencia = Number(carteira.valor_original || 0);
    indicadores = [
      { rotulo: "Saldo em aberto", valor: moedaCurta(aberto.valor), apoio: num(aberto.mensalidades) + " mensalidades", cor: VERMELHO },
      { rotulo: "Alunos com saldo em aberto", valor: num(aberto.alunos) + " alunos", apoio: "sem repetir aluno no ano", cor: "var(--rv-tinta)" },
      { rotulo: "Negociado desde jul/2026", valor: moedaCurta(hist.negociado), apoio: "conversão comprovada", cor: AZUL },
      { rotulo: "Recebido desde jul/2026", valor: moedaCurta(hist.recebido), apoio: "dinheiro recebido", cor: VERDE },
    ];
    situacao = [
      { rotulo: "Negociado desde julho", valor: hist.negociado, cor: AZUL },
      { rotulo: "Recebido desde julho", valor: hist.recebido, cor: VERDE },
      { rotulo: "Saldo em aberto (mensalidade original)", valor: aberto.valor, cor: VERMELHO },
      { rotulo: "Negociado direto com a Ulbra, a confirmar", valor: hist.ulbra_166?.valor, cor: AMBAR },
    ];
    referenciaRotulo = "da carteira residual do ano";
    rodape = "Carteira residual do ano: " + moeda(carteira.valor_original) + " · " + num(carteira.titulos)
           + " títulos · " + num(carteira.cpfs) + " alunos · entrada em cobrança de " + data(carteira.entrada_de)
           + " a " + data(carteira.entrada_ate) + " · situação na Prime coletada em "
           + data(historico?.prime_coletado_em);
  }

  // perfil dos alunos: só existe para 2026/1 (a coleta acadêmica cobre a carteira em aberto dessa safra).
  // Em 2024/2025 o mesmo lugar mostra de que curso vem o saldo em aberto.
  const perfil = safra === "2026/1" ? (academico?.categorias || []) : null;
  const perfilTotal = Number(academico?.total?.cpfs || 0);
  const cursos = hist ? (hist.cursos || []) : null;
  const cursosTotal = Number(hist?.aberto?.valor || 0);

  return (
    <div style={S.pagina}>
      <header style={S.tituloLinha}>
        <h1 style={S.h1}>Efetividade da Cobrança</h1>
        {/* Selo discreto: sinaliza que a AREA ainda esta sendo finalizada -- de
            proposito nao fala de dados nem de calculo, para nao passar a
            impressao de que os numeros sao provisorios. */}
        <button onClick={() => setObraAberta((v) => !v)}
                title="Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização."
                style={S.selo}>
          Em construção
        </button>
      </header>
      {obraAberta ? (
        <p style={S.seloTexto}>
          Esta área ainda está em construção e pode receber ajustes de layout, nomenclatura e visualização.
        </p>
      ) : null}

      {/* Escolha do período e identidade do período no MESMO bloco: o que se
          seleciona e o que se está vendo não podem morar longe um do outro. */}
      <div style={S.painelPeriodo}>
        <div style={S.navegacao}>
          <div style={S.navBloco}>
            <span style={S.navRotulo}>Ano</span>
            <div style={S.grupo} role="group" aria-label="Ano">
              {["2024", "2025", "2026"].map((a) => (
                <button key={a} onClick={() => setAno(a)} aria-pressed={ano === a}
                        style={{ ...S.opcao, ...(ano === a ? S.opcaoAtiva : null) }}>{a}</button>
              ))}
            </div>
          </div>
          {ano === "2026" ? (
            <div style={S.navBloco}>
              <span style={S.navRotulo}>Semestre</span>
              <div style={S.grupo} role="group" aria-label="Semestre">
                {[["1", "1º semestre"], ["2", "2º semestre"]].map(([k, r]) => (
                  <button key={k} onClick={() => setSem(k)} aria-pressed={sem === k}
                          style={{ ...S.opcao, ...(sem === k ? S.opcaoAtiva : null) }}>{r}</button>
                ))}
              </div>
            </div>
          ) : (
            <span style={S.chip}>Ano inteiro: em 2024 e 2025 os dois semestres são lidos juntos.</span>
          )}
        </div>
        <div style={S.periodo}>
          <strong style={S.periodoValor}>{periodo}</strong>
          <span style={S.periodoNatureza}>· {natureza}</span>
        </div>
      </div>

      {erro ? <p style={S.erro}>{erro}</p> : null}

      {indicadores.length === 0 ? (
        <p style={{ ...S.discreto, marginTop: 24 }}>Sem dados para {periodo}.</p>
      ) : (
        <>
          {/* 1. QUATRO INDICADORES — mesmo tamanho e mesma posição em toda safra */}
          <div style={S.linhaIndicadores}>
            {indicadores.map((i) => (
              <div key={i.rotulo} style={S.indicador}>
                <span style={{ ...S.indAcento, background: i.cor }} aria-hidden="true" />
                <span style={S.indRotulo}>{i.rotulo}</span>
                <strong style={{ ...S.indValor, color: i.cor }}>{i.valor}</strong>
                <span style={S.indApoio}>{i.apoio}</span>
              </div>
            ))}
          </div>
          {rodape ? <p style={S.rodapeDiscreto}>{rodape}</p> : null}

          {/* 2. SITUAÇÃO DA CARTEIRA — sempre barras simples, nunca tabela */}
          <section style={S.cartao}>
            <div style={S.cartaoCabecalho}>
              <h2 style={S.h2}>{tituloSituacao}</h2>
              {referencia > 0 && referenciaRotulo ? (
                <span style={S.cartaoApoio}>% {referenciaRotulo} · {moeda(referencia)}</span>
              ) : null}
            </div>
            <div>
              {situacao.map((l) => {
                const share = referencia > 0 ? (Number(l.valor || 0) / referencia) * 100 : 0;
                return (
                  <div key={l.rotulo} style={S.linha}>
                    <div style={S.linhaTopo}>
                      <span style={S.linhaRotulo}>
                        <span style={{ ...S.ponto, background: l.cor }} />{l.rotulo}
                      </span>
                      <strong style={S.linhaValor}>{moeda(l.valor)}</strong>
                      <span style={{ ...S.linhaPct, color: l.cor }}>
                        {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ ...S.barraPreenchida, width: Math.min(share, 100) + "%",
                                    minWidth: Number(l.valor || 0) > 0 ? 4 : 0, background: l.cor }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 3. PERFIL DOS ALUNOS (2026/1) ou, em 2024/2025, de que curso vem o saldo em aberto */}
          <section style={S.cartao}>
            <div style={S.cartaoCabecalho}>
              <h2 style={S.h2}>{cursos ? "Saldo em aberto por curso" : "Perfil dos alunos"}</h2>
              {cursos && cursosTotal > 0 ? (
                <span style={S.cartaoApoio}>% do saldo em aberto · {moeda(cursosTotal)}</span>
              ) : null}
            </div>
            {cursos ? (
              cursos.length > 0 ? (
                <div>
                  {cursos.map((c) => {
                    const share = cursosTotal > 0 ? (Number(c.valor || 0) / cursosTotal) * 100 : 0;
                    return (
                      <div key={c.curso} style={S.linha}>
                        <div style={S.linhaTopo}>
                          <span style={S.linhaRotulo}>
                            <span style={{ ...S.ponto, background: AZUL }} />{c.curso}
                          </span>
                          <strong style={S.linhaValor}>{moeda(c.valor)}</strong>
                          <span style={{ ...S.linhaPct, color: AZUL }}>
                            {share.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                          </span>
                        </div>
                        <span style={S.linhaApoio}>{num(c.alunos)} alunos · {num(c.mensalidades)} mensalidades</span>
                        <div style={S.trilho}>
                          <div style={{ ...S.barraPreenchida, width: Math.min(share, 100) + "%",
                                        minWidth: Number(c.valor || 0) > 0 ? 4 : 0, background: AZUL }} />
                        </div>
                      </div>
                    );
                  })}
                  <p style={{ ...S.discreto, marginTop: 10 }}>
                    Alunos contados uma vez por curso; quem tem mensalidade em dois cursos aparece nos dois.
                    {historico?.sem_semestre?.mensalidades
                      ? " Fora de 2024 e 2025: " + num(historico.sem_semestre.mensalidades)
                        + " mensalidades (" + moeda(historico.sem_semestre.valor) + ") que a Prime não liga a nenhuma série."
                      : ""}
                  </p>
                </div>
              ) : (
                <p style={{ ...S.discreto, marginTop: 8 }}>Sem saldo em aberto neste ano</p>
              )
            ) : perfil && perfil.length > 0 ? (
              <div>
                {perfil.map((c) => (
                  <div key={c.categoria} style={S.linha}>
                    <div style={S.linhaTopo}>
                      <span style={S.linhaRotulo}>
                        <span style={{ ...S.ponto, background: AZUL }} />{c.categoria}
                      </span>
                      <strong style={S.linhaValor}>{num(c.cpfs)} alunos</strong>
                      <span style={{ ...S.linhaPct, color: AZUL }}>
                        {Number(c.pct_cpfs).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                      </span>
                    </div>
                    <div style={S.trilho}>
                      <div style={{ ...S.barraPreenchida, width: Math.min(Number(c.pct_cpfs), 100) + "%",
                                    minWidth: Number(c.cpfs || 0) > 0 ? 4 : 0, background: AZUL }} />
                    </div>
                  </div>
                ))}
                <p style={{ ...S.discreto, marginTop: 10 }}>
                  {num(perfilTotal)} alunos com pendência nesta carteira. Situação acadêmica do Prime.
                </p>
              </div>
            ) : (
              <p style={{ ...S.discreto, marginTop: 8 }}>Informação acadêmica não disponível para este período</p>
            )}
          </section>

          {/* 4. METODOLOGIA — tudo o que é técnico mora aqui */}
          <div style={{ marginTop: 20 }}>
            <button onClick={() => setMetodologia((v) => !v)} aria-expanded={metodologia}
                    style={S.linkMetodologia}>
              <span aria-hidden="true">{metodologia ? "▾" : "▸"}</span>
              {metodologia ? "Ocultar metodologia" : "Ver metodologia"}
            </button>
            {metodologia ? (
              <div style={{ ...S.cartao, marginTop: 10, gap: 10 }}>
                <p style={S.texto}>
                  <strong>As três naturezas de período.</strong> <em>Carteira consolidada</em> (2026/1): safra fechada,
                  em que as quatro faixas somam 100% da carteira congelada. <em>Semestre vigente</em> (2026/2): o
                  semestre está em curso e há título a vencer, então não se calcula inadimplência — mostra-se só o que
                  já foi negociado e recebido. <em>Cobertura histórica</em> (2024 e 2025): o CRM não guarda nada
                  anterior a julho de 2026, então não há percentual de efetividade — o que existe é o saldo residual
                  que ainda estava aberto quando a carteira entrou em cobrança e as conversões comprovadas desde então.
                  2024 e 2025 são lidos pelo ano inteiro, com os dois semestres juntos; só 2026 se divide por semestre,
                  porque só ali o semestre muda a natureza do período.
                </p>
                <p style={S.texto}>
                  <strong>O saldo em aberto de 2024 e 2025.</strong> Conta só mensalidade original de graduação e pós
                  ainda no portador da Reativa, com o semestre vindo da série de cobrança da Prime — nunca do mês do
                  vencimento, que erra quando há matrícula antecipada. Ficam fora: acordo e parcela de acordo, título
                  que a Prime registra liquidado mais de 30 dias após o vencimento, confirmação de pagamento pendente,
                  caso cancelado ou jurídico, e aluno cujos pagamentos desde julho de 2026 já cobrem tudo o que ele
                  tem aberto no recorte. Cada aluno é contado uma vez no ano.
                </p>
                <p style={S.texto}>
                  <strong>Negociado direto com a Ulbra, a confirmar.</strong> Quando o CPF está no portador 166 da
                  Prime e não há acordo ativo no CRM, houve negociação fora daqui. Isso sai do saldo em aberto e
                  aparece em linha própria, porque a lista do portador existe por CPF e não por título: ela não diz
                  qual mensalidade foi negociada, então o valor é teto de exposição, não prova título a título.
                </p>
                <p style={S.texto}>
                  <strong>Como estes nomes se chamam na metodologia.</strong> Carteira convertida ={" "}
                  <em>efetividade comprovada</em>. Valor recebido = <em>recuperação financeira</em>. Em aberto sem
                  negociação = <em>inadimplência confirmada</em>. Em conferência = <em>em validação</em>. Na situação
                  do valor convertido, “negociado, hoje quebrado” e “negociado, hoje cancelado” continuam dentro do
                  convertido de propósito: a conversão é histórica — o valor foi alcançado pela cobrança, e o que mudou
                  depois foi a situação do acordo.
                </p>
                <p style={S.texto}>
                  <strong>Efetividade comprovada.</strong> Considera somente valores com evidência rastreável de
                  pagamento ou negociação. A efetividade de um título nunca passa do valor original — juros, multa e
                  honorários não aumentam a carteira recuperada. Um título negociado e depois pago não soma duas vezes:
                  o valor apenas muda de linha.
                </p>
                <p style={S.texto}>
                  <strong>Em conferência.</strong> Casos com indício de conversão, mas sem evidência suficiente para
                  classificação definitiva. Aparecem separados e não aumentam a carteira convertida.
                </p>
                <p style={S.texto}>
                  <strong>Precedência das fontes.</strong> A situação atual é do Prime — série e semestre do título,
                  título aberto ou liquidado, portador, matrícula e situação acadêmica. O estado do CRM não sobrepõe
                  informação disponível no Prime. O histórico de conversão (acordos, parcelas, pagamentos recebidos e
                  eventos de cobrança) vem do CRM e das importações operacionais, porque a API do Prime não entrega
                  esses dados. Quando o Prime não tem linha para o título, ninguém confirma que ele segue aberto: o
                  valor fica em conferência, nunca em aberto sem negociação.
                </p>
                <p style={S.texto}>
                  <strong>Situação atual não decide histórico.</strong> Está medido que um título negociado pode voltar
                  a aparecer aberto no Prime quando o acordo quebra — em 28,7% dos casos. Por isso “aberto hoje” nunca
                  é lido como “nunca foi negociado”.
                </p>
                <p style={S.texto}>
                  <strong>Histórico.</strong> O histórico estruturado de pagamentos disponível no CRM inicia em julho
                  de 2026. Vínculos anteriores ou não preservados integralmente podem permanecer em conferência até sua
                  reconstrução.
                </p>
                <p style={S.texto}>
                  <strong>Perfil dos alunos.</strong> Situação acadêmica vinda do Prime, por CPF único, para os alunos
                  que ainda têm pendência na carteira. Matrícula confirmada com dívida aberta aparece como exceção — o
                  aluno só efetiva matrícula com a ficha regularizada — e o painel não afirma a razão da exceção.
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

const S = {
  pagina: { padding: "28px 24px 56px", color: "var(--rv-tinta)", maxWidth: 1120, margin: "0 auto" },
  h1: { margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", fontFamily: "'Sora', Inter, sans-serif" },
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  tituloLinha: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },

  // ---- escolha do período (controles + identidade, no mesmo bloco) ----
  painelPeriodo: { marginTop: 18, background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
                   borderRadius: 14, padding: "12px 16px", display: "flex", alignItems: "center",
                   justifyContent: "space-between", gap: 14, flexWrap: "wrap", boxShadow: "var(--rv-sombra)",
                   maxWidth: "100%" },
  navegacao: { display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" },
  // flexWrap + minWidth 0: em 375px de largura os dois botões de semestre não
  // caberiam na linha e vazavam a tela; aqui eles quebram dentro da própria
  // pílula em vez de criar rolagem horizontal.
  navBloco: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
  navRotulo: { fontSize: 11, color: "var(--rv-texto-fraco)", fontWeight: 700, textTransform: "uppercase",
               letterSpacing: "0.06em" },
  grupo: { display: "inline-flex", flexWrap: "wrap", maxWidth: "100%", background: "var(--rv-fundo-suave)",
           borderRadius: 10, padding: 3, gap: 3 },
  opcao: { background: "none", border: "none", cursor: "pointer", padding: "7px 15px", borderRadius: 8,
           fontSize: 14, fontWeight: 500, color: "var(--rv-texto-suave)", fontFamily: "inherit" },
  opcaoAtiva: { background: "var(--rv-superficie)", color: "var(--rv-tinta)", fontWeight: 700,
                boxShadow: "0 1px 3px rgba(15,23,42,0.10)" },
  chip: { fontSize: 12.5, color: "var(--rv-texto-suave)", background: "var(--rv-fundo-suave)",
          border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "5px 12px" },

  periodo: { display: "flex", alignItems: "baseline", gap: 8, marginLeft: "auto" },
  periodoValor: { fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em",
                  fontFamily: "'Sora', Inter, sans-serif" },
  periodoNatureza: { fontSize: 13.5, color: "var(--rv-texto-suave)" },

  // ---- os quatro indicadores ----
  linhaIndicadores: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(214px, 1fr))", gap: 16,
                      marginTop: 20 },
  indicador: { position: "relative", display: "flex", flexDirection: "column", gap: 5, minHeight: 104,
               background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
               padding: "16px 18px 15px", boxShadow: "var(--rv-sombra)", overflow: "hidden" },
  indAcento: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
  // minHeight reserva DUAS linhas de rótulo: sem isso, "Em aberto sem
  // negociação" quebra em duas e o valor desce, desalinhando dos outros três.
  indRotulo: { fontSize: 12, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase",
               color: "var(--rv-texto-fraco)", lineHeight: 1.3, minHeight: 31 },
  indValor: { fontSize: 29, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
              fontFamily: "'Sora', Inter, sans-serif", fontVariantNumeric: "tabular-nums" },
  indApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)", marginTop: "auto" },
  rodapeDiscreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", marginTop: 14, lineHeight: 1.6 },

  // ---- cartões de seção ----
  cartao: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
            padding: "18px 22px 20px", marginTop: 20,
            boxShadow: "var(--rv-sombra)", display: "flex", flexDirection: "column", gap: 4 },
  cartaoCabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
                     flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid var(--rv-borda-suave)",
                     marginBottom: 4 },
  cartaoApoio: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  // ---- linha com barra: rótulo | valor | percentual, sempre alinhados ----
  linha: { padding: "11px 0" },
  linhaTopo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "baseline",
               columnGap: 14 },
  linhaRotulo: { fontSize: 14, fontWeight: 600, minWidth: 0 },
  linhaValor: { fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  linhaPct: { fontSize: 14, fontWeight: 700, minWidth: 58, textAlign: "right",
              fontVariantNumeric: "tabular-nums" },
  linhaApoio: { display: "block", fontSize: 12, color: "var(--rv-texto-fraco)", marginTop: 3 },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 8 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 7, overflow: "hidden", marginTop: 8 },
  // minWidth de 4px na barra: 1% de uma carteira de R$ 5 mi é real e não pode
  // desaparecer no trilho.
  barraPreenchida: { height: "100%", borderRadius: 999 },

  linkMetodologia: { display: "inline-flex", alignItems: "center", gap: 7, background: "var(--rv-superficie)",
                     border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "7px 14px",
                     cursor: "pointer", fontFamily: "inherit", color: "var(--rv-azul-texto)", fontSize: 13,
                     fontWeight: 600 },
  texto: { margin: 0, fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.6 },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", lineHeight: 1.6 },
  selo: { background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda-suave)",
          color: "var(--rv-texto-suave)", borderRadius: 999, padding: "3px 10px", fontSize: 11.5,
          fontWeight: 600, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em" },
  seloTexto: { margin: "8px 0 0", fontSize: 12.5, color: "var(--rv-texto-fraco)", maxWidth: 620, lineHeight: 1.5 },
  emBreve: { marginTop: 28, background: "var(--rv-superficie)", borderRadius: 16, padding: "40px 32px",
             boxShadow: "var(--rv-sombra)", border: "1px solid var(--rv-borda-suave)",
             display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, marginTop: 14 },
};
