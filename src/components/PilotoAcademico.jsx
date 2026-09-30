import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../services/supabase";

// PILOTO DA CONSULTA ACADÊMICA — até 100 alunos, um por vez
// ============================================================================
//
// UM CLIQUE INICIA O LOTE INTEIRO. Quem opera não clica aluno por aluno: aperta
// Iniciar e o laço abaixo pede o próximo, consulta, e repete. O "um por vez" é
// da CHAMADA, não do clique — nunca há duas consultas em voo ao mesmo tempo.
//
// POR QUE O LAÇO MORA NO NAVEGADOR. Cada consulta leva ~4 s; 100 alunos passam
// de 6 minutos, muito além do teto de uma Edge Function. Aqui o progresso é
// visível a cada item, dá para pausar no meio, e fechar a aba não deixa nada
// pendurado — o estado está no banco, e retomar continua de onde parou.
//
// O QUE INTERROMPE, e não é negociável:
//   401/403/429 da API  -> a RPC marca o lote INTERROMPIDO e o laço para.
//                          Insistir contra um sistema que acabou de dizer
//                          "pare" é como se perde acesso.
//   teto de requisições -> paginação conta; o teto é de requisições, não de
//                          alunos.
//   Pausar              -> decisão de quem está olhando.
//
// ANTES DE CADA CHAMADA o servidor confere se a ficha já consultou aquele
// aluno desde que o lote foi preparado. Se já, o item vira PULADO sem gastar
// requisição — a consulta automática da ficha continua viva e não pode fazer o
// piloto refazer trabalho.

const LIMITE_ALUNOS = 100;
const LIMITE_REQUISICOES = 300;

function dataHora(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export default function PilotoAcademico({ ano, semestre }) {
  const [lotes, setLotes] = useState([]);
  const [lote, setLote] = useState(null);       // lote em foco
  const [rodando, setRodando] = useState(false);
  const [ultimo, setUltimo] = useState(null);   // texto do último item processado
  const [reconciliado, setReconciliado] = useState(null);
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  // `pararRef` é lido DENTRO do laço. Um estado de React não serve aqui: o
  // laço captura o valor do render em que começou, e Pausar nunca chegaria
  // nele. O ref é a mesma caixa em todas as voltas.
  const pararRef = useRef(false);
  const vivoRef = useRef(true);

  useEffect(() => () => { vivoRef.current = false; pararRef.current = true; }, []);

  const carregarPainel = useCallback(async (focar) => {
    const { data, error } = await supabase.rpc("prime_academico_piloto_painel", { p_lote: null });
    if (error) { setErro(error.message); return; }
    const lista = Array.isArray(data) ? data : [];
    if (!vivoRef.current) return;
    setLotes(lista);
    const alvo = focar || lote?.lote_id;
    setLote(lista.find((l) => l.lote_id === alvo) || lista[0] || null);
  }, [lote?.lote_id]);

  // A CARGA INICIAL usa `.then`, e nao a funcao `async` acima, por um motivo
  // do lint que e tambem uma verdade sobre o React: dentro de uma funcao
  // `async` chamada no corpo do efeito, a regra nao consegue ver que a escrita
  // de estado acontece depois de um `await`, e trata como escrita sincrona --
  // que gera renderizacao em cascata. Com `.then` fica explicito que a escrita
  // e de callback.
  useEffect(() => {
    let vivo = true;
    supabase
      .rpc("prime_academico_piloto_painel", { p_lote: null })
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) { setErro(error.message); return; }
        const lista = Array.isArray(data) ? data : [];
        setLotes(lista);
        setLote(lista[0] || null);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  async function preparar() {
    setErro(null); setOcupado(true);
    try {
      const { data, error } = await supabase.rpc("prime_academico_piloto_criar", {
        p_ano: String(ano), p_semestre: semestre ? String(semestre) : null,
        p_limite_alunos: LIMITE_ALUNOS, p_limite_requisicoes: LIMITE_REQUISICOES,
      });
      if (error) throw error;
      await carregarPainel(data?.lote_id);
      setUltimo(`Fila criada com ${data?.itens ?? 0} alunos. Nenhuma consulta foi feita.`);
    } catch (e) {
      setErro(e?.message || "Não foi possível preparar o lote.");
    } finally { setOcupado(false); }
  }

  // O LAÇO. Uma chamada por vez, sempre.
  async function iniciar() {
    if (!lote?.lote_id) return;
    setErro(null); setRodando(true); pararRef.current = false;
    try {
      // Retomar um lote que a API interrompeu é decisão humana: o botão só
      // aparece com o aviso, e `p_forcar` é o "eu sei o que aconteceu".
      if (lote.estado === "INTERROMPIDO") {
        const { data } = await supabase.rpc("prime_academico_piloto_retomar",
          { p_lote: lote.lote_id, p_forcar: true });
        if (data && data.ok === false) { setErro(data.motivo || "não foi possível retomar"); return; }
      }

      // UMA EXECUÇÃO POR LOTE. Sem isto, duas abas alternavam pedidos no mesmo
      // lote e cada uma achava que o orçamento inteiro era dela -- com 1
      // requisição sobrando, as duas começavam.
      const { data: ini, error: eIni } = await supabase.rpc(
        "prime_academico_piloto_iniciar", { p_lote: lote.lote_id });
      if (eIni) { setErro(eIni.message); return; }
      if (!ini?.ok) { setErro(ini?.motivo || "não foi possível iniciar este lote"); return; }
      const execucao = ini.execucao_id;

      for (;;) {
        if (pararRef.current || !vivoRef.current) { setUltimo("Pausado."); break; }

        const { data: prox, error: e1 } = await supabase.rpc(
          "prime_academico_piloto_proximo", { p_lote: lote.lote_id, p_execucao: execucao });
        if (e1) { setErro(e1.message); break; }
        const rec = prox?.reconciliacao;
        if (rec && (rec.reconciliados > 0 || rec.devolvidos > 0)) {
          setReconciliado(`Reconciliação: ${rec.reconciliados} fechado(s) por consulta já gravada, `
                          + `${rec.devolvidos} devolvido(s) à fila.`);
        }
        if (!prox || prox.parar) {
          setUltimo(prox?.motivo ? `Parou: ${prox.motivo}` : "Parou.");
          break;
        }

        const { data: r, error: e2 } = await supabase.functions.invoke("prime-academico", {
          body: { aluno_id: prox.aluno_id, piloto_item_id: prox.item_id, piloto_execucao: execucao },
        });

        // A função responde erro de duas formas: `error` (HTTP fora de 2xx) e
        // `data.erro` (quando ela escolhe devolver 200 com diagnóstico). As
        // duas param o laço -- insistir em cima de um erro desconhecido gasta
        // a API sem saber por quê.
        const falhou = e2 || r?.erro;
        if (falhou) {
          const cod = r?.erro || e2?.message || "erro desconhecido";
          setErro(
            r?.erro === "PILOTO_REGISTRO_FALHOU"
              // Caso delicado: a consulta FOI gravada e já foi paga. Retomar
              // reconcilia esse item pela consulta que existe -- não repete a
              // chamada ao Prime.
              ? `Interrompido no aluno ${prox.ordem}: a consulta foi gravada, mas o registro do item falhou (${r.detalhe ?? "?"}). `
                + "Retomar reconcilia este item sem consultar o Prime de novo."
              : `Interrompido no aluno ${prox.ordem}: ${cod}${r?.detalhe ? " — " + r.detalhe : ""}`,
          );
          await carregarPainel(lote.lote_id);
          break;
        }

        setUltimo(`Aluno ${prox.ordem} · ${r?.resultado ?? "?"} · ${r?.requisicoes ?? "?"} requisição(ões)`);
        await carregarPainel(lote.lote_id);

        if (r?.piloto?.parar) { setErro(r.piloto.motivo || "lote interrompido pela API"); break; }
      }
    } finally {
      setRodando(false);
      await carregarPainel(lote?.lote_id);
    }
  }

  async function pausar() {
    pararRef.current = true;
    if (lote?.lote_id) await supabase.rpc("prime_academico_piloto_pausar", { p_lote: lote.lote_id });
    await carregarPainel(lote?.lote_id);
  }

  const recorte = ano === "2026" ? `${ano}/${semestre || "1"}` : String(ano);
  const total = Number(lote?.itens || 0);
  const pulados = Math.max(0, total - Number(lote?.pendentes || 0) - Number(lote?.concluidos || 0) - Number(lote?.falhas || 0));
  const pct = total > 0 ? Math.min(100, Math.round(100 * (total - Number(lote?.pendentes || 0)) / total)) : 0;

  return (
    <section style={S.caixa}>
      <div style={S.cab}>
        <h3 style={S.titulo}>Piloto da consulta acadêmica · {recorte}</h3>
        <span style={S.selo}>sem execução automática</span>
      </div>

      <p style={S.explica}>
        Até <b>{LIMITE_ALUNOS} alunos</b> ainda não consultados, <b>uma chamada por vez</b>,
        com teto de <b>{LIMITE_REQUISICOES} requisições</b> (a paginação conta). Quem a ficha
        já consultou é pulado sem gastar chamada.
      </p>

      <div style={S.botoes}>
        <button type="button" onClick={preparar} disabled={ocupado || rodando} style={S.botao}>
          {ocupado ? "Preparando…" : "Preparar lote"}
        </button>
        {lote && lote.pendentes > 0 && !rodando && (
          <button type="button" onClick={iniciar} style={{ ...S.botao, ...S.botaoPrimario }}>
            {lote.estado === "INTERROMPIDO" ? "Retomar mesmo assim" : "Iniciar lote"}
          </button>
        )}
        {rodando && (
          <button type="button" onClick={pausar} style={{ ...S.botao, ...S.botaoPausar }}>Pausar</button>
        )}
      </div>

      {erro && <p style={S.erro}>{erro}</p>}

      {lote ? (
        <div style={S.progresso}>
          <div style={S.trilho}>
            <div style={{ ...S.barra, width: pct + "%" }} />
          </div>
          <p style={S.numeros}>
            <b>{total - Number(lote.pendentes || 0)}</b> de <b>{total}</b> · {pct}%
            {" · "}{lote.concluidos} consultados
            {Number(lote.falhas) > 0 ? ` · ${lote.falhas} com falha` : ""}
            {pulados > 0 ? ` · ${pulados} pulados` : ""}
          </p>
          <p style={S.numeros}>
            Requisições: <b>{lote.requisicoes_gastas}</b> de {lote.limite_requisicoes}
            {" · estado: "}<b>{lote.estado}</b>
            {lote.motivo ? ` · ${lote.motivo}` : ""}
          </p>
          <p style={S.discreto}>
            Lote criado em {dataHora(lote.criado_em)}
            {lote.criado_por ? ` por ${lote.criado_por}` : ""}
          </p>
          {reconciliado && <p style={S.discreto}>{reconciliado}</p>}
          {ultimo && <p style={S.discreto}>{ultimo}</p>}
        </div>
      ) : (
        <p style={S.discreto}>Nenhum lote preparado ainda.</p>
      )}

      {lotes.length > 1 && (
        <p style={S.discreto}>
          {lotes.length} lotes registrados. Mostrando o mais recente.
        </p>
      )}
    </section>
  );
}

const S = {
  caixa: { marginTop: 14, padding: "14px 16px", borderRadius: 10,
           background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)" },
  cab: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" },
  titulo: { margin: 0, fontSize: 14, fontWeight: 700, color: "var(--rv-tinta)" },
  selo: { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
          background: "rgba(100,116,139,0.14)", color: "var(--rv-texto)" },
  explica: { margin: "8px 0 12px", fontSize: 12.5, color: "var(--rv-texto)", maxWidth: 720 },
  botoes: { display: "flex", flexWrap: "wrap", gap: 8 },
  botao: { fontSize: 12.5, fontWeight: 600, padding: "6px 13px", borderRadius: 7, cursor: "pointer",
           background: "var(--rv-fundo)", color: "var(--rv-tinta)", border: "1px solid var(--rv-borda)" },
  botaoPrimario: { background: "rgba(37,99,235,0.12)", borderColor: "rgba(37,99,235,0.35)" },
  botaoPausar: { background: "rgba(180,83,9,0.12)", borderColor: "rgba(180,83,9,0.35)" },
  progresso: { marginTop: 12 },
  trilho: { height: 8, borderRadius: 999, background: "rgba(100,116,139,0.18)", overflow: "hidden" },
  barra: { height: "100%", background: "var(--rv-teal-texto)", transition: "width .2s" },
  numeros: { margin: "7px 0 0", fontSize: 12.5, color: "var(--rv-tinta)" },
  discreto: { margin: "6px 0 0", fontSize: 11.5, color: "var(--rv-texto)" },
  erro: { margin: "10px 0 0", padding: "8px 10px", borderRadius: 7, fontSize: 12.5,
          background: "rgba(185,28,28,0.10)", color: "var(--rv-vermelho-texto)",
          border: "1px solid rgba(185,28,28,0.30)" },
};
