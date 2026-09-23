import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabase";
import { STATUS_CONCILIACAO } from "../../utils/conciliacaoPagamento";
import {
  MOTIVO_CATEGORIA, RESULTADO_ANALISE, SITUACAO_PARCELA, STATUS_BAIXA, STATUS_FILA,
  rotulo, rotuloConclusao, rotuloRejeicao, moeda, dataBR, dataHoraBR, exportar,
} from "../../utils/relatorioNaoBaixados";

// NAO BAIXADOS / REJEITADOS -- a aba de consulta e exportacao da Projecao.
//
// Responde, sem sair daqui: o pagamento entrou -> foi baixado? se nao, por que?
// se ja foi analisado, qual foi a decisao?
//
// SOMENTE LEITURA, e isso nao e promessa de comentario: a unica RPC que esta
// tela chama e `projecao_nao_baixados`, declarada STABLE no banco -- o Postgres
// recusa qualquer escrita dentro dela. Abrir a aba nao baixa, nao devolve
// baixa, nao reprocessa pagamento e nao mexe na fila. FEITO e REJEITAR
// continuam sendo executados em "Pagamentos sem vinculo".
//
// POR PADRAO a aba mostra o que NAO baixou e tem estado registrado -- 60
// pagamentos / R$ 57.620,47 em 23/09/2026. Os anteriores a 14/09/2026 ficam
// atras de uma caixa propria porque nao tem motivo gravado: eles entram como
// MOTIVO_NAO_CLASSIFICADO, que e um estado explicito, nunca um campo vazio.

const VAZIO = {
  pagamento_de: "", pagamento_ate: "", importacao_de: "", importacao_ate: "",
  termo: "", boleto: "", valor_min: "", valor_max: "", saldo: "",
  status_conciliacao: [], motivo: [], resultado: [], situacao_parcela: [],
  incluir_sem_estado: false, incluir_baixados: false, ordem: "VALOR_DESC",
};

// Montado a partir dos mesmos catalogos que o banco usa. Nunca uma lista
// digitada a parte: um valor que o banco nao conhece nao filtraria nada.
const OPCOES_STATUS = Object.keys(STATUS_CONCILIACAO).filter((s) => s !== "BAIXADO");
const OPCOES_RESULTADO = ["PENDENTE", "FEITO", "REJEITADO", "ENCERRADO_GESTAO", "RESOLVIDO_AUTOMATICO"];
const OPCOES_PARCELA = ["SEM_PARCELA", "VENCIDA", "A_VENCER", "PAGA", "CANCELADA"];

function alterna(lista, valor) {
  return lista.includes(valor) ? lista.filter((x) => x !== valor) : [...lista, valor];
}

// So vai para o banco o que a gestao realmente preencheu: campo vazio nao vira
// filtro, e array vazio nao vira "nenhum resultado".
function paraFiltros(f) {
  const out = {};
  for (const k of ["pagamento_de", "pagamento_ate", "importacao_de", "importacao_ate", "termo", "boleto", "saldo"]) {
    if (String(f[k] || "").trim() !== "") out[k] = String(f[k]).trim();
  }
  for (const k of ["valor_min", "valor_max"]) {
    if (String(f[k] || "").trim() !== "" && Number.isFinite(Number(f[k]))) out[k] = Number(f[k]);
  }
  for (const k of ["status_conciliacao", "motivo", "resultado", "situacao_parcela"]) {
    if ((f[k] || []).length > 0) out[k] = f[k];
  }
  if (f.incluir_sem_estado) out.incluir_sem_estado = true;
  if (f.incluir_baixados) out.incluir_baixados = true;
  if (f.ordem && f.ordem !== "VALOR_DESC") out.ordem = f.ordem;
  return out;
}

export default function NaoBaixadosRejeitados() {
  const [form, setForm] = useState(VAZIO);
  const [aplicados, setAplicados] = useState(VAZIO);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [visao, setVisao] = useState("PAGAMENTO");
  const [aberto, setAberto] = useState({});

  const carregar = useCallback(async (f) => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("projecao_nao_baixados", { p_filtros: paraFiltros(f) });
    setCarregando(false);
    if (error) {
      setErro(
        error.code === "42501" || /gestao financeira/i.test(error.message || "")
          ? "Este relatório é da gestão financeira."
          : "Não foi possível carregar o relatório: " + (error.message || ""),
      );
      setDados(null);
      return;
    }
    setDados(data || null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar(VAZIO);
  }, [carregar]);

  const c = dados?.contadores || {};
  const linhas = useMemo(() => dados?.linhas || [], [dados]);
  const porAluno = useMemo(() => dados?.por_aluno || [], [dados]);

  // A visao por aluno abre os pagamentos daquele aluno sem ir ao banco de novo:
  // as linhas ja vieram. Aluno sem id (pagamento ainda sem vinculo) agrupa pelo
  // nome, a mesma chave que o banco usou.
  const linhasPorAluno = useMemo(() => {
    const m = {};
    for (const l of linhas) {
      const chave = l.aluno_id || `SEM_ALUNO:${l.aluno_nome || "?"}`;
      (m[chave] = m[chave] || []).push(l);
    }
    return m;
  }, [linhas]);

  function aplicar() {
    setAplicados(form);
    setAberto({});
    carregar(form);
  }

  function limpar() {
    setForm(VAZIO);
    setAplicados(VAZIO);
    setAberto({});
    carregar(VAZIO);
  }

  const mudar = (k, v) => setForm((x) => ({ ...x, [k]: v }));

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h3 style={S.titulo}>Não baixados / Rejeitados</h3>
          <p style={S.sub}>
            O pagamento entrou na Projeção — foi baixado? Se não, por quê? Se já
            foi analisado, qual foi a decisão? Somente leitura: abrir ou exportar
            não baixa, não devolve baixa e não mexe na fila. <b>Feito</b> e{" "}
            <b>Rejeitar</b> continuam em <i>Pagamentos sem vínculo</i>.
          </p>
        </div>
        <div style={S.acoesTopo}>
          <button type="button" style={S.btnGhost} onClick={() => carregar(aplicados)} disabled={carregando}>
            {carregando ? "Carregando…" : "Atualizar"}
          </button>
          <button
            type="button"
            style={S.btnExportar}
            disabled={carregando || !dados || (c.linhas || 0) === 0}
            onClick={() => exportar(dados)}
          >
            ⬇️ Exportar relatório (.xlsx)
          </button>
        </div>
      </div>

      {erro && <p style={S.erro}>{erro}</p>}

      {/* CONTADORES -- respeitam os filtros aplicados, e sao contados sobre o
          conjunto INTEIRO no banco, nunca sobre a lista que coube na tela. */}
      <div style={S.faixa}>
        <Cartao rotuloTexto="Não baixados" valor={c.nao_baixados ?? 0} />
        <Cartao rotuloTexto="Valor não baixado" valor={moeda(c.valor_nao_baixado)} destaque />
        <Cartao rotuloTexto="Pendentes" valor={c.pendentes ?? 0} extra={moeda(c.valor_pendente)} />
        <Cartao rotuloTexto="Feito" valor={c.feito ?? 0} extra={moeda(c.valor_feito)} />
        <Cartao rotuloTexto="Rejeitados" valor={c.rejeitado ?? 0} extra={moeda(c.valor_rejeitado)} />
        <Cartao rotuloTexto="Sem estrutura" valor={c.sem_estrutura ?? 0} />
        <Cartao rotuloTexto="Aguardando acordo" valor={c.aguardando_acordo ?? 0} />
        <Cartao rotuloTexto="Alunos envolvidos" valor={c.alunos_unicos ?? 0} />
      </div>

      {/* Invariante do relatorio: se um dia aparecer linha sem motivo, a tela
          grita em vez de mostrar campo vazio, que foi o que a gestao proibiu. */}
      {(c.sem_motivo || 0) > 0 && (
        <p style={S.erro}>
          ⚠️ {c.sem_motivo} linha(s) sem motivo. Isso não deveria acontecer — avise antes de usar o relatório.
        </p>
      )}

      <div style={S.filtros}>
        <Campo rotuloTexto="Pagamento de">
          <input type="date" style={S.input} value={form.pagamento_de} onChange={(e) => mudar("pagamento_de", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="até">
          <input type="date" style={S.input} value={form.pagamento_ate} onChange={(e) => mudar("pagamento_ate", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="Importado de">
          <input type="date" style={S.input} value={form.importacao_de} onChange={(e) => mudar("importacao_de", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="até">
          <input type="date" style={S.input} value={form.importacao_ate} onChange={(e) => mudar("importacao_ate", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="Aluno, matrícula ou CPF">
          <input style={S.input} placeholder="nome, matrícula ou CPF" value={form.termo} onChange={(e) => mudar("termo", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="Boleto">
          <input style={S.input} placeholder="50712620001" value={form.boleto} onChange={(e) => mudar("boleto", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="Valor de">
          <input style={{ ...S.input, width: 100 }} inputMode="decimal" value={form.valor_min} onChange={(e) => mudar("valor_min", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="até">
          <input style={{ ...S.input, width: 100 }} inputMode="decimal" value={form.valor_max} onChange={(e) => mudar("valor_max", e.target.value)} />
        </Campo>
        <Campo rotuloTexto="Saldo do aluno">
          <select style={S.input} value={form.saldo} onChange={(e) => mudar("saldo", e.target.value)}>
            <option value="">qualquer</option>
            <option value="COM">com saldo atual</option>
            <option value="ZERO">saldo zero</option>
          </select>
        </Campo>
        <Campo rotuloTexto="Ordenação">
          <select style={S.input} value={form.ordem} onChange={(e) => mudar("ordem", e.target.value)}>
            <option value="VALOR_DESC">maior valor → menor</option>
            <option value="ANTIGO_PRIMEIRO">mais antigo → mais recente</option>
          </select>
        </Campo>
      </div>

      <GrupoChips
        rotuloTexto="Status de conciliação"
        opcoes={OPCOES_STATUS}
        mapa={MOTIVO_CATEGORIA}
        valor={form.status_conciliacao}
        onToggle={(v) => mudar("status_conciliacao", alterna(form.status_conciliacao, v))}
      />
      <GrupoChips
        rotuloTexto="Resultado da análise"
        opcoes={OPCOES_RESULTADO}
        mapa={RESULTADO_ANALISE}
        valor={form.resultado}
        onToggle={(v) => mudar("resultado", alterna(form.resultado, v))}
      />
      <GrupoChips
        rotuloTexto="Situação da parcela"
        opcoes={OPCOES_PARCELA}
        mapa={SITUACAO_PARCELA}
        valor={form.situacao_parcela}
        onToggle={(v) => mudar("situacao_parcela", alterna(form.situacao_parcela, v))}
      />

      <div style={S.linhaAcoes}>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={form.incluir_sem_estado}
            onChange={(e) => mudar("incluir_sem_estado", e.target.checked)}
          />
          Incluir os anteriores a 14/09/2026 (sem motivo gravado)
        </label>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={form.incluir_baixados}
            onChange={(e) => mudar("incluir_baixados", e.target.checked)}
          />
          Histórico completo (inclusive o que baixou certo)
        </label>
        <button type="button" style={S.btnAplicar} onClick={aplicar} disabled={carregando}>
          Aplicar filtros
        </button>
        <button type="button" style={S.btnGhost} onClick={limpar} disabled={carregando}>
          Limpar
        </button>
      </div>

      <div style={S.linhaAcoes}>
        <div style={S.visaoBox}>
          <button
            type="button"
            style={visao === "PAGAMENTO" ? S.visaoAtiva : S.visao}
            onClick={() => setVisao("PAGAMENTO")}
          >
            Por pagamento
          </button>
          <button
            type="button"
            style={visao === "ALUNO" ? S.visaoAtiva : S.visao}
            onClick={() => setVisao("ALUNO")}
          >
            Por aluno
          </button>
        </div>
        <span style={S.resumo}>
          {carregando
            ? "carregando…"
            : `${c.linhas ?? 0} pagamento(s) · ${moeda(c.valor_total)} · ${c.alunos_unicos ?? 0} aluno(s)`}
        </span>
      </div>

      {dados?.truncado && (
        <p style={S.avisoTrunc}>
          A lista mostra as {dados.limite} primeiras linhas desta ordenação — os
          contadores acima e a exportação continuam contando o filtro inteiro.
          Estreite o período para ver o resto na tela.
        </p>
      )}

      {!carregando && (c.linhas ?? 0) === 0 && (
        <p style={S.muted}>Nenhum pagamento da Projeção nesta seleção.</p>
      )}

      {!carregando && (c.linhas ?? 0) > 0 && visao === "PAGAMENTO" && (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Pagamento</th>
                <th style={S.th}>Aluno</th>
                <th style={S.th}>Boleto / acordo</th>
                <th style={S.thNum}>Valor</th>
                <th style={S.th}>Baixa</th>
                <th style={S.th}>Motivo</th>
                <th style={S.th}>Análise</th>
                <th style={S.thNum}>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <LinhaPagamento key={l.pagamento_id} l={l} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!carregando && (c.linhas ?? 0) > 0 && visao === "ALUNO" && (
        <div style={S.rolagem}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Aluno</th>
                <th style={S.thNum}>Não baixados</th>
                <th style={S.thNum}>Valor total</th>
                <th style={S.thNum}>Pendente</th>
                <th style={S.thNum}>Feito</th>
                <th style={S.thNum}>Rejeitado</th>
                <th style={S.thNum}>Saldo atual</th>
                <th style={S.th}>Período</th>
                <th style={S.th}>Principal motivo</th>
              </tr>
            </thead>
            <tbody>
              {porAluno.map((a) => {
                const chave = a.aluno_id || `SEM_ALUNO:${a.aluno_nome || "?"}`;
                const abertoAqui = !!aberto[chave];
                const filhas = linhasPorAluno[chave] || [];
                return [
                  <tr key={chave} style={S.trClicavel} onClick={() => setAberto((x) => ({ ...x, [chave]: !x[chave] }))}>
                    <td style={S.td}>
                      <span style={S.seta}>{abertoAqui ? "▾" : "▸"}</span>
                      {a.aluno_nome || "(sem aluno identificado)"}
                      <div style={S.subLinha}>
                        {a.matricula || "sem matrícula"}
                        {a.cpf_mascarado ? ` · ${a.cpf_mascarado}` : ""}
                      </div>
                    </td>
                    <td style={S.tdNum}>{a.qtd_nao_baixado}</td>
                    <td style={S.tdNum}>{moeda(a.valor_total)}</td>
                    <td style={S.tdNum}>{a.qtd_pendente}</td>
                    <td style={S.tdNum}>{a.qtd_feito}</td>
                    <td style={S.tdNum}>{a.qtd_rejeitado}</td>
                    <td style={S.tdNum}>{moeda(a.saldo_total)}</td>
                    <td style={S.td}>
                      {dataBR(a.pagamento_mais_antigo)} → {dataBR(a.ultimo_pagamento)}
                    </td>
                    <td style={S.td}>{rotulo(MOTIVO_CATEGORIA, a.principal_motivo)}</td>
                  </tr>,
                  abertoAqui ? (
                    <tr key={`${chave}-det`}>
                      <td style={S.tdDetalhe} colSpan={9}>
                        {filhas.length === 0 ? (
                          <span style={S.muted}>
                            os pagamentos deste aluno ficaram fora do trecho carregado — estreite o filtro
                          </span>
                        ) : (
                          filhas.map((l) => (
                            <div key={l.pagamento_id} style={S.detalheItem}>
                              <b>{dataBR(l.data_pagamento)}</b> · {moeda(l.valor_pago)} · boleto{" "}
                              {l.boleto || "—"} · {rotulo(STATUS_BAIXA, l.status_baixa)} ·{" "}
                              {rotulo(RESULTADO_ANALISE, l.resultado_analise)}
                              <div style={S.subLinha}>{l.motivo_texto}</div>
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LinhaPagamento({ l }) {
  return (
    <tr>
      <td style={S.td}>
        {dataBR(l.data_pagamento)}
        <div style={S.subLinha}>importado {dataHoraBR(l.importado_em) || "—"}</div>
      </td>
      <td style={S.td}>
        {l.aluno_nome || "(sem aluno identificado)"}
        <div style={S.subLinha}>
          {l.matricula || "sem matrícula"}
          {l.cpf_mascarado ? ` · ${l.cpf_mascarado}` : ""}
        </div>
      </td>
      <td style={S.td}>
        {l.boleto || "—"}
        <div style={S.subLinha}>
          {l.acordo_numero ? `acordo ${l.acordo_numero}` : "acordo não identificado"}
          {l.parcela_numero != null ? ` · parcela ${l.parcela_numero}` : ""}
        </div>
      </td>
      <td style={S.tdNum}>{moeda(l.valor_pago)}</td>
      <td style={S.td}>
        <span style={l.status_baixa === "BAIXADO" ? S.seloOk : S.seloAlerta}>
          {rotulo(STATUS_BAIXA, l.status_baixa)}
        </span>
        <div style={S.subLinha}>parcela: {rotulo(SITUACAO_PARCELA, l.situacao_parcela)}</div>
      </td>
      <td style={S.tdMotivo}>
        <b>{rotulo(MOTIVO_CATEGORIA, l.motivo_categoria)}</b>
        <div style={S.subLinha}>{l.motivo_texto}</div>
      </td>
      <td style={S.td}>
        {rotulo(RESULTADO_ANALISE, l.resultado_analise)}
        <div style={S.subLinha}>{rotulo(STATUS_FILA, l.status_fila)}</div>
        {l.conclusao && <div style={S.subLinha}>conclusão: {rotuloConclusao(l.conclusao)}</div>}
        {l.motivo_rejeicao && (
          <div style={S.subLinhaAlerta}>rejeição: {rotuloRejeicao(l.motivo_rejeicao)}</div>
        )}
        {l.observacao && <div style={S.subLinha}>“{l.observacao}”</div>}
        {l.decidido_por && (
          <div style={S.subLinha}>
            {l.decidido_por} · {dataHoraBR(l.decidido_em)}
          </div>
        )}
        <div style={S.subLinha}>
          {l.quantidade_tentativas} tentativa(s)
          {l.ultima_tentativa_em ? ` · última ${dataHoraBR(l.ultima_tentativa_em)}` : ""}
        </div>
      </td>
      <td style={S.tdNum}>{moeda(l.saldo_total)}</td>
    </tr>
  );
}

function Cartao({ rotuloTexto, valor, extra, destaque }) {
  return (
    <div style={S.cartao}>
      <div style={destaque ? S.cartaoValorForte : S.cartaoValor}>{valor}</div>
      <div style={S.cartaoRotulo}>{rotuloTexto}</div>
      {extra ? <div style={S.cartaoExtra}>{extra}</div> : null}
    </div>
  );
}

function Campo({ rotuloTexto, children }) {
  return (
    <label style={S.campo}>
      <span style={S.campoRotulo}>{rotuloTexto}</span>
      {children}
    </label>
  );
}

function GrupoChips({ rotuloTexto, opcoes, mapa, valor, onToggle }) {
  return (
    <div style={S.chips}>
      <span style={S.campoRotulo}>{rotuloTexto}</span>
      {opcoes.map((o) => (
        <button
          key={o}
          type="button"
          style={valor.includes(o) ? S.chipAtivo : S.chip}
          onClick={() => onToggle(o)}
        >
          {rotulo(mapa, o)}
        </button>
      ))}
    </div>
  );
}

const S = {
  wrap: { padding: "18px 4px" },
  topo: { display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  titulo: { margin: 0, fontSize: 17, fontWeight: 800, color: "var(--rv-tinta)" },
  sub: { margin: "4px 0 0", fontSize: 13, color: "var(--rv-texto-suave)", maxWidth: 680, lineHeight: 1.5 },
  acoesTopo: { display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" },
  faixa: { display: "flex", gap: 10, flexWrap: "wrap", margin: "0 0 14px" },
  cartao: { flex: "1 1 120px", minWidth: 120, background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 10, padding: "10px 12px" },
  cartaoValor: { fontSize: 19, fontWeight: 800, color: "var(--rv-tinta)" },
  cartaoValorForte: { fontSize: 19, fontWeight: 800, color: "var(--rv-vermelho-texto)" },
  cartaoRotulo: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", marginTop: 2 },
  cartaoExtra: { fontSize: 11.5, color: "var(--rv-texto-suave)", marginTop: 2 },
  filtros: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 },
  campo: { display: "flex", flexDirection: "column", gap: 3 },
  campoRotulo: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)" },
  input: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "7px 10px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)" },
  chips: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 },
  chip: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)", border: "1px solid var(--rv-borda)", borderRadius: 999, padding: "4px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  chipAtivo: { background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 999, padding: "4px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  linhaAcoes: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", margin: "10px 0" },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--rv-texto-suave)" },
  btnGhost: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnAplicar: { background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo-texto)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  btnExportar: { background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 8, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  visaoBox: { display: "flex", gap: 6 },
  visao: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  visaoAtiva: { background: "var(--rv-superficie)", color: "var(--rv-tinta)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 800, cursor: "pointer" },
  resumo: { fontSize: 13, fontWeight: 700, color: "var(--rv-texto-forte)" },
  avisoTrunc: { fontSize: 12.5, color: "var(--rv-texto-suave)", margin: "0 0 8px", maxWidth: 680 },
  muted: { color: "var(--rv-texto-suave)", fontSize: 14 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, fontWeight: 600 },
  rolagem: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "var(--rv-superficie)", borderRadius: 10, overflow: "hidden" },
  th: { textAlign: "left", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 12px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  td: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)", verticalAlign: "top" },
  tdMotivo: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", color: "var(--rv-texto-forte)", verticalAlign: "top", maxWidth: 380 },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", fontWeight: 700, color: "var(--rv-tinta)", verticalAlign: "top", whiteSpace: "nowrap" },
  tdDetalhe: { padding: "6px 12px 12px 34px", borderBottom: "1px solid var(--rv-borda-suave)", background: "var(--rv-fundo-suave)" },
  detalheItem: { fontSize: 12.5, color: "var(--rv-texto-forte)", padding: "5px 0" },
  subLinha: { fontSize: 11.5, color: "var(--rv-texto-suave)", marginTop: 2, lineHeight: 1.45 },
  subLinhaAlerta: { fontSize: 11.5, color: "var(--rv-vermelho-texto)", fontWeight: 700, marginTop: 2 },
  trClicavel: { cursor: "pointer" },
  seta: { marginRight: 6, color: "var(--rv-texto-fraco)" },
  seloOk: { fontSize: 11, fontWeight: 700, color: "var(--rv-verde-ok-texto)", background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 999, padding: "2px 8px" },
  seloAlerta: { fontSize: 11, fontWeight: 700, color: "var(--rv-vermelho-texto)", background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 999, padding: "2px 8px" },
};
