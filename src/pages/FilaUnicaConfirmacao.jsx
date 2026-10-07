import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../services/supabase";
import ResolverEmConfirmacao from "../components/ResolverEmConfirmacao";
import { S, moeda, num, dataCurta } from "../components/situacoesDaSafraFormato";

// FILA UNICA DE CONFIRMACAO — a tela de TRATAMENTO das pendencias.
//
// A Efetividade responde "quanto esta pendente e por que"; aqui se trata. Cada
// valor que aparece como pendente lá chega aqui como REGISTRO INDIVIDUAL:
// aluno, CPF, titulo, safra, valor, motivo, situacao atual, evidencia
// disponivel, responsavel, data de entrada na pendencia e a acao necessaria.
//
// NAO E FILA PARALELA. Esta tela nao tem motor proprio, nao tem tabela propria
// e nao decide nada: ela LE `carteira_pendencias_itens` e, para resolver,
// embute o fluxo que ja existe. Em `Em confirmacao de pagamento` quem resolve e
// `ResolverEmConfirmacao` — o MESMO componente que ja vive na fila do extrato e
// na ficha do aluno, chamando as MESMAS RPCs da Conferencia Prime
// (`prime_conferencia_vincular` / `_seguir_pagamento` / `_rejeitar`), com motivo
// obrigatorio, as mesmas travas e a mesma auditoria. O selo "Aguardando
// confirmacao de pagamento", a Fila Operacional e a Conferencia Prime seguem
// funcionando como antes; nada aqui duplica aquele mecanismo.
//
// SUBMOTIVO SEM ACAO SEGURA NAO GANHA BOTAO. `carteira_pendencia_acao` diz, em
// SQL, qual acao a regra existente permite. Hoje so `em_confirmacao` tem
// caminho por caso; os outros quatro aparecem com motivo e evidencia, marcados
// como "sem acao automatica segura", e a tela oferece apenas abrir a ficha do
// aluno. Criar aqui uma acao generica que edite valor ou status final seria
// atuar fora da origem do dado, sem historico e sem auditoria — e e exatamente
// o que nao se pode fazer.
//
// REFETCH DEPOIS DA RESOLUCAO. Resolvido um caso, a tela refaz a contagem por
// motivo E a pagina de itens — sem reload da aplicacao.
//
// LE FOTOGRAFIA (ajuste de 07/10/2026). A contagem vem de
// `carteira_efetividade_ler` e os itens de `carteira_pendencias_itens_ler`, que
// e uma leitura indexada da tabela de fotografia. A consulta viva de 2026/1
// passa por `carteira_2026_1_classificar`, medida em ~21 s em producao, e o
// teto do papel `authenticated` e 8 s — a fila nao podia depender dela.
//
// CONSEQUENCIA QUE A TELA DIZ: resolver um caso o resolve na origem na hora (as
// RPCs da Conferencia Prime sao as mesmas), mas a CONTAGEM e a LISTA desta fila
// so deixam de mostra-lo na proxima reconstrucao da rotina. O rodape declara a
// data da fotografia, para ninguem ler a lista como estado ao vivo.

const SAFRAS = [
  { chave: "2024",   ano: "2024", semestre: null, rotulo: "2024" },
  { chave: "2025",   ano: "2025", semestre: null, rotulo: "2025" },
  { chave: "2026/1", ano: "2026", semestre: "1",  rotulo: "2026/1" },
];

const POR_PAGINA = 50;

const soDigitos = (v) => String(v || "").replace(/\D/g, "");
// CPF mascarado só para leitura; a busca e a identificacao usam o valor cru.
const cpf = (v) => {
  const d = soDigitos(v);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : (v || "—");
};

export default function FilaUnicaConfirmacao() {
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();

  // A safra e o motivo vem da URL: e assim que a Efetividade "entrega" o caso
  // aqui, e e o que faz o link ser compartilhavel e o botao voltar funcionar.
  const safraUrl = useMemo(() => {
    const ano = params.get("ano");
    const semestre = params.get("semestre");
    const achada = SAFRAS.find((s) => s.ano === ano && (s.semestre || null) === (semestre || null));
    return achada || SAFRAS[2];
  }, [params]);
  const motivoUrl = params.get("motivo") || null;

  const [resumo, setResumo] = useState(null);
  const [erroResumo, setErroResumo] = useState("");
  const [itens, setItens] = useState(null);
  const [erroItens, setErroItens] = useState("");
  const [carregandoItens, setCarregandoItens] = useState(false);
  const [pagina, setPagina] = useState(0);
  // Incrementado a cada resolucao e a cada "Atualizar dados": e a dependencia
  // que faz as duas consultas refazerem sem reload da aplicacao.
  const [recarga, setRecarga] = useState(0);

  // `useMemo` e não `resumo?.motivos || []` solto: o array literal do fallback
  // nasceria novo a cada render e faria o `useMemo` do motivo recalcular
  // sempre (a catraca do lint aponta exatamente isso).
  const motivos = useMemo(() => resumo?.motivos || [], [resumo]);
  const semFotografia = Boolean(resumo?.sem_snapshot);
  // Motivo efetivo: o da URL, se existir nesta safra; senao o de maior valor.
  const motivo = useMemo(() => {
    if (motivoUrl && motivos.some((m) => m.chave === motivoUrl)) return motivoUrl;
    return motivos[0]?.chave || null;
  }, [motivoUrl, motivos]);
  const motivoAtual = motivos.find((m) => m.chave === motivo) || null;

  // ---------------------------------------------------------------- resumo
  useEffect(() => {
    let ativo = true;
    (async () => {
      setErroResumo("");
      const { data, error } = await supabase.rpc("carteira_efetividade_ler",
        { p_bloco: "pendencias_por_motivo", p_ano: safraUrl.ano, p_semestre: safraUrl.semestre });
      if (!ativo) return;
      if (error) { setErroResumo(error.message || "falha ao consultar"); setResumo(null); }
      else setResumo(data || null);
    })();
    return () => { ativo = false; };
  }, [safraUrl, recarga]);

  // ----------------------------------------------------------------- itens
  const buscarItens = useCallback(async () => {
    if (!motivo) return;
    setCarregandoItens(true);
    setErroItens("");
    const { data, error } = await supabase.rpc("carteira_pendencias_itens_ler", {
      p_motivo: motivo, p_ano: safraUrl.ano, p_semestre: safraUrl.semestre,
      p_limite: POR_PAGINA, p_offset: pagina * POR_PAGINA,
    });
    if (error) { setErroItens(error.message || "falha ao consultar"); setItens([]); }
    else setItens(data || []);
    setCarregandoItens(false);
  }, [motivo, safraUrl, pagina]);

  useEffect(() => {
    let ativo = true;
    (async () => { if (ativo) await buscarItens(); })();
    return () => { ativo = false; };
  }, [buscarItens, recarga]);

  function trocarSafra(s) {
    // Trocar de safra zera a pagina e solta o motivo: nem todo motivo existe em
    // toda safra, e manter um motivo inexistente deixaria a fila vazia sem
    // dizer por que.
    setPagina(0);
    const q = { ano: s.ano, ...(s.semestre ? { semestre: s.semestre } : {}) };
    setParams(new URLSearchParams(q));
  }

  function trocarMotivo(chave) {
    setPagina(0);
    const q = { ano: safraUrl.ano, ...(safraUrl.semestre ? { semestre: safraUrl.semestre } : {}), motivo: chave };
    setParams(new URLSearchParams(q));
  }

  const temAcao = motivoAtual?.acao === "CONFERENCIA_PRIME";

  return (
    <div style={E.pagina}>
      <header style={E.topo}>
        <div>
          <h1 style={E.h1}>Fila Única de Confirmação</h1>
          <p style={E.sub}>
            Onde as pendências da Efetividade são tratadas, caso a caso. Cada linha é um título real, com o
            motivo, a evidência e o responsável. A resolução acontece pelo fluxo oficial de cada tipo — esta
            tela não corrige valor nem status por fora.
          </p>
        </div>
        <div style={E.acoesTopo}>
          <button type="button" style={E.botaoNeutro} onClick={() => setRecarga((v) => v + 1)}>
            Atualizar dados
          </button>
          <button type="button" style={E.botaoNeutro} onClick={() => navegar("/carteira-2026-1")}>
            ← Efetividade
          </button>
        </div>
      </header>

      <div style={E.filtros}>
        <div style={E.filtroBloco}>
          <span style={E.filtroRotulo}>Safra</span>
          <div style={E.grupo} role="group" aria-label="Safra">
            {SAFRAS.map((s) => (
              <button key={s.chave} type="button" onClick={() => trocarSafra(s)}
                      aria-pressed={s.chave === safraUrl.chave}
                      style={{ ...E.opcao, ...(s.chave === safraUrl.chave ? E.opcaoAtiva : null) }}>
                {s.rotulo}
              </button>
            ))}
          </div>
        </div>
        {motivos.length ? (
          <div style={E.filtroBloco}>
            <span style={E.filtroRotulo}>Motivo da pendência</span>
            <div style={E.grupo} role="group" aria-label="Motivo da pendência">
              {motivos.map((m) => (
                <button key={m.chave} type="button" onClick={() => trocarMotivo(m.chave)}
                        aria-pressed={m.chave === motivo}
                        title={m.acao === "CONFERENCIA_PRIME"
                          ? "Resolve-se pelo fluxo da Conferência Prime"
                          : "Sem ação automática segura: entra na fila com motivo e evidência"}
                        style={{ ...E.opcao, ...(m.chave === motivo ? E.opcaoAtiva : null) }}>
                  {m.rotulo} · {num(m.titulos)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {erroResumo ? <p style={S.erro}>Não foi possível contar as pendências: {erroResumo}</p> : null}

      {semFotografia ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          <strong>Esta safra ainda não tem fotografia das pendências.</strong> A rotina da hora reconstrói;
          assim que ela rodar, a fila aparece. Isto é diferente de “nenhuma pendência”.
        </p>
      ) : null}

      {motivoAtual ? (
        <div style={E.cabecalhoMotivo}>
          <strong style={E.motivoNome}>{motivoAtual.rotulo}</strong>
          <span style={E.motivoApoio}>
            {num(motivoAtual.alunos)} {Number(motivoAtual.alunos) === 1 ? "aluno" : "alunos"} ·{" "}
            {num(motivoAtual.titulos)} {Number(motivoAtual.titulos) === 1 ? "título" : "títulos"} ·{" "}
            {moeda(motivoAtual.valor)} · safra {safraUrl.rotulo}
          </span>
          {temAcao ? (
            <span style={E.seloOk}>resolve pela Conferência Prime</span>
          ) : (
            <span style={E.seloAviso}>sem ação automática segura</span>
          )}
        </div>
      ) : null}

      {!temAcao && motivoAtual ? (
        <p style={E.explicacao}>
          <strong>Não existe regra de resolução por caso para este motivo.</strong> A fila mostra o registro
          com motivo e evidência para análise humana, e não oferece botão de resolução — atuar aqui no valor
          ou no status final seria mexer fora da origem do dado, sem histórico e sem auditoria. O caminho é
          abrir a ficha do aluno e tratar na origem correta.
        </p>
      ) : null}

      {erroItens ? <p style={S.erro}>Não foi possível listar os casos: {erroItens}</p> : null}

      {carregandoItens && itens === null ? (
        <p style={S.discreto}>Carregando os casos desta pendência…</p>
      ) : !itens || !itens.length ? (
        <p style={S.discreto}>
          {motivo ? "Nenhum caso nesta pendência." : "Nenhuma pendência nesta safra."}
        </p>
      ) : (
        <>
          <div style={E.lista}>
            {itens.map((i) => (
              <article key={i.titulo_id} style={E.caso}>
                <div style={E.casoTopo}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={E.alunoNome}>{i.aluno_nome || "— sem nome na base —"}</strong>
                    <div style={E.linhaDados}>
                      CPF {cpf(i.cpf)} · boleto {i.documento || "—"} · venc. {dataCurta(i.vencimento)} ·
                      safra {i.safra}
                    </div>
                  </div>
                  <strong style={E.casoValor}>{moeda(i.valor)}</strong>
                </div>

                <dl style={E.campos}>
                  <div style={E.campo}>
                    <dt style={E.dt}>Motivo</dt>
                    <dd style={E.dd}>{i.motivo_rotulo}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Situação atual</dt>
                    <dd style={E.dd}>{i.situacao_titulo || "—"}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Responsável</dt>
                    <dd style={E.dd}>{i.responsavel_email || "— sem responsável —"}</dd>
                  </div>
                  <div style={E.campo}>
                    <dt style={E.dt}>Na pendência desde</dt>
                    <dd style={E.dd}>{dataCurta(i.desde)}</dd>
                  </div>
                </dl>

                <p style={E.evidencia}>
                  <span style={E.evidenciaRotulo}>Evidência disponível:</span> {i.evidencia}
                </p>

                <div style={E.casoAcoes}>
                  {/* AÇÃO NECESSÁRIA. Em confirmação de pagamento reaproveita o
                      fluxo existente, inteiro: o componente consulta
                      `conferencia_em_confirmacao_do_aluno`, mostra o efeito que
                      o banco calculou e executa pelas RPCs da Conferência
                      Prime. Limitado ao título DESTA linha, para a fila tratar
                      um caso por vez. */}
                  {i.acao === "CONFERENCIA_PRIME" ? (
                    <div style={E.resolver}>
                      <ResolverEmConfirmacao
                        alunoId={i.aluno_id}
                        tituloId={i.titulo_id}
                        onResolvido={() => setRecarga((v) => v + 1)}
                      />
                    </div>
                  ) : (
                    <span style={E.semAcao}>Sem ação automática segura — análise humana</span>
                  )}
                  <button type="button" style={E.botaoNeutro}
                          onClick={() => navegar(`/aluno?alunoId=${encodeURIComponent(i.aluno_id)}&origem=fila-unica`)}>
                    Abrir ficha do aluno
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div style={E.paginacao}>
            <button type="button" style={E.botaoNeutro} disabled={pagina === 0 || carregandoItens}
                    onClick={() => setPagina((p) => Math.max(0, p - 1))}>
              ← Anteriores
            </button>
            <span style={E.paginaTexto}>
              Casos {pagina * POR_PAGINA + 1}–{pagina * POR_PAGINA + itens.length}
              {motivoAtual ? " de " + num(motivoAtual.titulos) : ""}
            </span>
            <button type="button" style={E.botaoNeutro}
                    disabled={itens.length < POR_PAGINA || carregandoItens}
                    onClick={() => setPagina((p) => p + 1)}>
              Próximos →
            </button>
          </div>
        </>
      )}

      <p style={S.rodape}>
        <strong>Esta fila não substitui nenhuma outra.</strong> “Em confirmação de pagamento” é o mesmo
        universo que a Conferência Prime e o selo “Aguardando confirmação de pagamento” já tratam, com as
        mesmas RPCs e a mesma auditoria — aqui ele aparece organizado por safra e por motivo, junto das
        outras pendências que compõem o número da Efetividade. Resolver um caso aqui o resolve lá, e
        vice-versa.
      </p>
      {resumo?.snapshot?.gerado_em ? (
        <p style={S.rodape}>
          <strong>Fotografia de {dataCurta(resumo.snapshot.gerado_em)}</strong>, reconstruída pela rotina da
          hora fora da requisição desta tela — o cálculo ao vivo passa do teto de 8s em 2026/1. Depois de
          cada resolução a fila refaz a leitura, sem recarregar a aplicação; o caso resolvido sai da origem
          na hora e sai desta lista na próxima reconstrução.
        </p>
      ) : null}
    </div>
  );
}

const E = {
  pagina: { padding: "22px clamp(14px, 3vw, 30px) 40px", maxWidth: 1180, margin: "0 auto" },
  topo: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
          flexWrap: "wrap", marginBottom: 16 },
  h1: { margin: 0, fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800, letterSpacing: "-0.02em",
        fontFamily: "'Sora', Inter, sans-serif" },
  sub: { margin: "6px 0 0", fontSize: 13, color: "var(--rv-texto-suave)", lineHeight: 1.55,
         maxWidth: 680 },
  acoesTopo: { display: "flex", gap: 8, flexWrap: "wrap" },

  filtros: { display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 14 },
  filtroBloco: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  filtroRotulo: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  grupo: { display: "flex", gap: 6, flexWrap: "wrap" },
  opcao: { background: "var(--rv-superficie)", color: "var(--rv-texto)",
           border: "1px solid var(--rv-borda-forte)", borderRadius: 999, padding: "5px 12px",
           fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  // `border` inteiro, não `borderColor`: misturar shorthand com propriedade
  // isolada no mesmo elemento faz o React avisar de bug de estilo na rerender.
  opcaoAtiva: { background: "var(--rv-azul)", color: "#fff", border: "1px solid var(--rv-azul)" },

  cabecalhoMotivo: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
                     padding: "10px 0 6px", borderTop: "1px solid var(--rv-borda-suave)" },
  motivoNome: { fontSize: 16, fontWeight: 800, fontFamily: "'Sora', Inter, sans-serif" },
  motivoApoio: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },
  seloOk: { fontSize: 10.5, fontWeight: 700, color: "var(--rv-verde-ok)",
            border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "2px 9px" },
  seloAviso: { fontSize: 10.5, fontWeight: 700, color: "var(--rv-ambar-texto)",
               border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "2px 9px" },
  explicacao: { fontSize: 12.5, color: "var(--rv-texto-suave)", lineHeight: 1.6, margin: "8px 0 0",
                maxWidth: 820 },

  lista: { display: "flex", flexDirection: "column", gap: 12, marginTop: 14 },
  caso: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)",
          borderRadius: 14, padding: "14px 16px", boxShadow: "var(--rv-sombra)" },
  casoTopo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
              flexWrap: "wrap" },
  alunoNome: { fontSize: 14.5, fontWeight: 800, display: "block" },
  linhaDados: { fontSize: 12, color: "var(--rv-texto-fraco)", marginTop: 2,
                fontVariantNumeric: "tabular-nums" },
  casoValor: { fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums",
               fontFamily: "'Sora', Inter, sans-serif", whiteSpace: "nowrap" },

  campos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10,
            margin: "12px 0 0" },
  campo: { minWidth: 0 },
  dt: { fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  dd: { margin: "2px 0 0", fontSize: 12.5, color: "var(--rv-texto)", overflowWrap: "anywhere" },

  evidencia: { fontSize: 12, color: "var(--rv-texto-suave)", lineHeight: 1.55,
               margin: "12px 0 0", paddingTop: 10, borderTop: "1px solid var(--rv-borda-suave)" },
  evidenciaRotulo: { fontWeight: 800, color: "var(--rv-texto)" },

  casoAcoes: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10 },
  resolver: { flex: "1 1 320px", minWidth: 0 },
  semAcao: { fontSize: 12, fontWeight: 700, color: "var(--rv-ambar-texto)" },

  paginacao: { display: "flex", gap: 10, alignItems: "center", justifyContent: "center",
               flexWrap: "wrap", marginTop: 16 },
  paginaTexto: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  botaoNeutro: { background: "var(--rv-superficie)", color: "var(--rv-texto)",
                 border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 12px",
                 fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
};
