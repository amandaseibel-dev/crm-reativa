// Conciliacao com o extrato do Santander -- a fila que define quem pagou.
//
// Amanda: "sempre a fila pela entradas do santander, ali definimos quem
// realmente pagou", "vamos conseguir trabalhar e estancar os maiores casos
// primeiro" e "otimize tudo que puder nessa aba, para ficar mais fluida a
// confirmacao de pagamento".
//
// O QUE FAZ ELA SER RAPIDA, em ordem de impacto:
//
// 1. FAIXA. Nao se trabalha 1.364 linhas. Medido em 29/08/2026, 95 alunos
//    (10k+) concentram R$ 3.377.909,10 -- 53% do saldo -- e os 393 abaixo de
//    R$ 1.000 somam 3,5%. O seletor de faixa e o caminho curto para estancar.
// 2. LIMITE NO BANCO. A fila tinha 1.364 linhas e a API corta em 1.000 sem
//    avisar (premissa 13): a tela mostraria fila truncada com cara de completa.
//    A RPC limita e devolve `total_faixa`, e a tela diz "300 de 1.364".
// 3. DESFAZER. Decidiu errado, volta com um clique nos 12 segundos seguintes.
//    E o que permite ir rapido sem medo -- vale mais que qualquer atalho.
// 4. TECLADO. J/K anda, C confirma, R rejeita, Q quita, Enter abre a ficha,
//    / foca a busca. Sem tirar a mao para o mouse a cada linha.
// 5. SEM window.confirm/prompt. Confirmacao acontece NA LINHA, sem modal do
//    navegador travando o fluxo.
// 6. Placar da sessao: quantos e quanto ja foram resolvidos agora.
//
// NAO COMPARAR VALOR PAGO COM SALDO: o extrato traz valor cheio e o nosso
// registro traz principal, entao pagar mais que o saldo e o normal de quem
// quitou a vista (premissa 17).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

const FAIXAS = [
  { min: 50000, rotulo: "R$ 50 mil +" },
  { min: 20000, rotulo: "R$ 20 mil +" },
  { min: 10000, rotulo: "R$ 10 mil +" },
  { min: 5000, rotulo: "R$ 5 mil +" },
  { min: 1000, rotulo: "R$ 1 mil +" },
  { min: 0, rotulo: "Todas" },
];

// Janela para desfazer um clique errado.
const SEGUNDOS_DESFAZER = 12;

export default function ConciliacaoSantander() {
  const [linhas, setLinhas] = useState([]);
  const [totalFaixa, setTotalFaixa] = useState(0);
  const [saldoFaixa, setSaldoFaixa] = useState(0);
  const [pgtosFaixa, setPgtosFaixa] = useState(0);
  const [entrouFaixa, setEntrouFaixa] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [faixa, setFaixa] = useState(10000);
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");
  const [cursor, setCursor] = useState(0);
  const [confirmando, setConfirmando] = useState(null); // {alunoId, acao}
  const [motivo, setMotivo] = useState("");
  const [ocupado, setOcupado] = useState(null);
  const [desfazer, setDesfazer] = useState(null); // {linha, acao, expiraEm}
  const [placar, setPlacar] = useState({ n: 0, valor: 0 });
  const [fichaId, setFichaId] = useState(null);
  const [backlog, setBacklog] = useState(null);
  const buscaRef = useRef(null);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    const [fila, bl] = await Promise.all([
      supabase.rpc("conciliacao_santander", {
        p_desde: "2026-07-01", p_faixa_min: faixa, p_limite: 300,
      }),
      supabase.rpc("backlog_manual"),
    ]);
    if (fila.error) setErro(fila.error.message);
    const dados = fila.data || [];
    setLinhas(dados);
    setTotalFaixa(dados[0]?.total_faixa ?? dados.length);
    setSaldoFaixa(dados[0]?.saldo_faixa ?? 0);
    setPgtosFaixa(dados[0]?.pagamentos_faixa ?? 0);
    setEntrouFaixa(dados[0]?.entrou_faixa ?? 0);
    setBacklog(bl.data || null);
    setCursor(0);
    setCarregando(false);
  }, [faixa]);

  useEffect(() => { carregar(); }, [carregar]);

  // Busca com folga: filtrar 300 linhas a cada tecla trava a digitacao.
  useEffect(() => {
    const t = setTimeout(() => setBuscaAtiva(busca), 180);
    return () => clearTimeout(t);
  }, [busca]);

  const visiveis = useMemo(() => {
    const t = buscaAtiva.trim().toLowerCase();
    if (!t) return linhas;
    const dig = t.replace(/\D/g, "");
    return linhas.filter((x) =>
      String(x.nome || "").toLowerCase().includes(t) ||
      (dig && String(x.cpf || "").replace(/\D/g, "").includes(dig)));
  }, [linhas, buscaAtiva]);

  // Cursor sempre dentro da lista atual, derivado -- sem efeito corrigindo
  // estado depois do render.
  const alvo = visiveis.length === 0 ? -1 : Math.min(cursor, visiveis.length - 1);

  // Conta regressiva do desfazer.
  useEffect(() => {
    if (!desfazer) return undefined;
    const t = setTimeout(() => setDesfazer(null), SEGUNDOS_DESFAZER * 1000);
    return () => clearTimeout(t);
  }, [desfazer]);

  async function aplicar(l, acao, motivoTexto) {
    setOcupado(l.aluno_id);
    setConfirmando(null);
    try {
      if (acao === "CONFIRMADO") {
        const { error } = await supabase.rpc("confirmar_baixa_caso", {
          p_aluno_id: l.aluno_id, p_valor_pago: Number(l.entrou),
          p_data_pagamento: l.ultimo_pagamento, p_confirmacao_id: null,
        });
        if (error) throw error;
      }
      if (acao === "QUITADO") {
        const { error } = await supabase.rpc("quitar_e_encerrar_caso", {
          p_aluno_id: l.aluno_id, p_valor: Number(l.entrou),
          p_data: l.ultimo_pagamento, p_confirmar_acordo_em_dia: true,
        });
        if (error) throw error;
      }
      const { error: e2 } = await supabase.rpc("conciliacao_santander_decidir", {
        p_aluno_id: l.aluno_id, p_decisao: acao,
        p_motivo: motivoTexto || null, p_valor: Number(l.entrou),
      });
      if (e2) throw e2;

      setLinhas((ls) => ls.filter((x) => x.aluno_id !== l.aluno_id));
      setTotalFaixa((n) => Math.max(0, n - 1));
      setPlacar((p) => ({ n: p.n + 1, valor: p.valor + Number(l.saldo_aberto || 0) }));
      setDesfazer({ linha: l, acao });
      setMotivo("");
    } catch (e) {
      alert("Não foi possível concluir: " + (e?.message || String(e)));
    } finally {
      setOcupado(null);
    }
  }

  const desfazerAgora = useCallback(async () => {
    if (!desfazer) return;
    const { linha, acao } = desfazer;
    setDesfazer(null);
    const { error } = await supabase.rpc("conciliacao_santander_desfazer", { p_aluno_id: linha.aluno_id });
    if (error) { alert("Não foi possível desfazer: " + error.message); return; }
    setLinhas((ls) => [linha, ...ls].sort((a, b) => Number(b.saldo_aberto) - Number(a.saldo_aberto)));
    setTotalFaixa((n) => n + 1);
    setPlacar((p) => ({ n: Math.max(0, p.n - 1), valor: Math.max(0, p.valor - Number(linha.saldo_aberto || 0)) }));
    if (acao !== "REJEITADO") {
      alert("O aluno voltou para a fila. A baixa em si NÃO foi estornada — se for o caso, desfaça pelo fluxo do Financeiro.");
    }
  }, [desfazer]);

  function pedirAcao(l, acao) {
    if (acao === "REJEITADO") { setConfirmando({ alunoId: l.aluno_id, acao }); setMotivo(""); return; }
    setConfirmando({ alunoId: l.aluno_id, acao });
  }

  // Teclado: a fila e feita para ser percorrida sem mouse.
  useEffect(() => {
    function onKey(e) {
      if (fichaId) return;
      const emCampo = ["INPUT", "TEXTAREA"].includes(e.target?.tagName);
      if (e.key === "/" && !emCampo) { e.preventDefault(); buscaRef.current?.focus(); return; }
      if (e.key === "Escape") { setConfirmando(null); e.target?.blur?.(); return; }
      if (emCampo) return;
      const l = visiveis[alvo];
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(alvo + 1, visiveis.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(alvo - 1, 0)); }
      else if (e.key === "u" && desfazer) { e.preventDefault(); desfazerAgora(); }
      else if (!l) return;
      else if (e.key === "c") { e.preventDefault(); pedirAcao(l, "CONFIRMADO"); }
      else if (e.key === "r") { e.preventDefault(); pedirAcao(l, "REJEITADO"); }
      else if (e.key === "q") { e.preventDefault(); pedirAcao(l, "QUITADO"); }
      else if (e.key === "Enter") { e.preventDefault(); setFichaId(l.aluno_id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visiveis, alvo, fichaId, desfazer, desfazerAgora]);

  const rotuloFaixa = FAIXAS.find((f) => f.min === faixa)?.rotulo || "Todas";

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Conciliação com o Santander</h1>
          <p style={S.sub}>
            Pagamentos de julho e agosto que <b>ainda não foram conferidos</b>, de quem ainda tem saldo.
            Uma linha por aluno, com os dois meses somados. Quem já está zerado sai da lista — já foi
            conferido. Decidir aqui carimba os pagamentos daquele aluno, e a fila diminui.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={faixas}>
        {FAIXAS.map((f) => (
          <button
            key={f.min}
            type="button"
            onClick={() => setFaixa(f.min)}
            style={{ ...chipFaixa, ...(f.min === faixa ? chipFaixaOn : null) }}
            aria-pressed={f.min === faixa}
          >
            {f.rotulo}
          </button>
        ))}
        <span style={dicaTeclado}>
          <b>J/K</b> anda · <b>C</b> confirma · <b>R</b> rejeita · <b>Q</b> quita · <b>Enter</b> abre a ficha · <b>/</b> busca
        </span>
      </div>

      <div style={S.barra}>
        <input
          ref={buscaRef}
          style={S.input}
          placeholder="Buscar por nome ou CPF…   (tecle /)"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>
            {visiveis.length < totalFaixa ? `${visiveis.length} de ${totalFaixa}` : `${totalFaixa}`} alunos
          </span>
          <span style={S.contadorAlunos}>{pgtosFaixa} pagamentos</span>
          <span style={S.contadorAcordos}>{moeda(entrouFaixa)} entrou</span>
          <span style={S.contadorValor}>{moeda(saldoFaixa)} em aberto</span>
          {placar.n > 0 ? (
            <span style={S.contadorAcordos}>✓ {placar.n} resolvidos · {moeda(placar.valor)}</span>
          ) : null}
        </div>
      </div>

      {linhas.length < totalFaixa ? (
        <p style={avisoCorte}>
          Mostrando os <b>{linhas.length}</b> maiores de <b>{totalFaixa}</b> alunos
          ({pgtosFaixa} pagamentos) na faixa {rotuloFaixa}. Resolva estes e clique em Atualizar,
          ou estreite a faixa.
        </p>
      ) : null}

      {backlog ? (
        <p style={contexto}>
          Ainda a lançar: <b>{backlog.pagamentos_sem_baixa}</b> pagamentos
          ({moeda(backlog.pagamentos_sem_baixa_valor)}) sem fechar parcela ou título,
          e <b>{backlog.acordos_sem_vinculo}</b> acordos sem mensalidade vinculada.
          O saldo desta fila cai à medida que isso é feito.
        </p>
      ) : null}

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>Nada pendente nesta faixa.</p>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Aluno</th>
              <th style={S.thNum}>Entrou</th>
              <th style={S.thNum}>Saldo</th>
              <th style={S.thNum}>Em acordo</th>
              <th style={S.thNum}>Mensalidade</th>
              <th style={S.thNum}>Vencido</th>
              <th style={S.th}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((l, i) => {
              const destacada = i === alvo;
              const conf = confirmando?.alunoId === l.aluno_id ? confirmando.acao : null;
              return (
                <tr
                  key={l.aluno_id}
                  onMouseEnter={() => setCursor(i)}
                  style={destacada ? { background: "#eff6ff", outline: "2px solid #bfdbfe" } : undefined}
                >
                  <td style={S.td}>
                    <button type="button" onClick={() => setFichaId(l.aluno_id)} style={linkNome}>
                      {l.nome}
                    </button>
                    <div style={sub}>
                      CPF {l.cpf || "-"} · {l.responsavel} · {l.qtd_pagamentos} pagamento
                      {l.qtd_pagamentos === 1 ? "" : "s"} até {curta(l.ultimo_pagamento)}
                    </div>
                  </td>
                  <td style={{ ...S.tdNum, fontWeight: 800, color: "#166534" }}>{moeda(l.entrou)}</td>
                  <td style={{ ...S.tdNum, fontWeight: 800 }}>{moeda(l.saldo_aberto)}</td>
                  <td style={S.tdNum}>{moeda(l.saldo_em_acordo)}</td>
                  <td style={S.tdNum}>{moeda(l.saldo_em_mensalidade)}</td>
                  <td style={{ ...S.tdNum, color: Number(l.saldo_vencido) > 0 ? "#9f1239" : "#94a3b8" }}>
                    {moeda(l.saldo_vencido)}
                  </td>
                  <td style={S.td}>
                    {conf ? (
                      <div style={caixaConf}>
                        {conf === "REJEITADO" ? (
                          <input
                            autoFocus
                            style={inputMotivo}
                            placeholder="Motivo (obrigatório)…"
                            value={motivo}
                            onChange={(e) => setMotivo(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && motivo.trim()) aplicar(l, "REJEITADO", motivo.trim());
                              if (e.key === "Escape") setConfirmando(null);
                            }}
                          />
                        ) : (
                          <span style={txtConf}>
                            {conf === "QUITADO"
                              ? <>Encerrar <b>{moeda(l.saldo_aberto)}</b> e tirar da cobrança?</>
                              : <>Registrar baixa de <b>{moeda(l.entrou)}</b>?</>}
                          </span>
                        )}
                        <button
                          type="button"
                          style={btnOk}
                          disabled={conf === "REJEITADO" && !motivo.trim()}
                          onClick={() => aplicar(l, conf, conf === "REJEITADO" ? motivo.trim() : null)}
                        >
                          Sim
                        </button>
                        <button type="button" style={btnNao} onClick={() => setConfirmando(null)}>Não</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          style={ocupado === l.aluno_id ? S.btnBusy : S.btnConf}
                          disabled={ocupado === l.aluno_id}
                          onClick={() => pedirAcao(l, "CONFIRMADO")}
                          title="Registra a baixa com o valor do Santander. Só quita se o saldo zerar. (C)"
                        >
                          Confirmar
                        </button>
                        <button
                          type="button" style={S.btnRej} disabled={ocupado === l.aluno_id}
                          onClick={() => pedirAcao(l, "REJEITADO")} title="Não ajustar, com motivo. (R)"
                        >
                          Rejeitar
                        </button>
                        <button
                          type="button" style={btnQuitar} disabled={ocupado === l.aluno_id}
                          onClick={() => pedirAcao(l, "QUITADO")} title="Encerra o caso inteiro. (Q)"
                        >
                          Quitar tudo
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {desfazer ? (
        <div style={toast}>
          <span>
            <b>{desfazer.linha.nome}</b> — {desfazer.acao === "CONFIRMADO" ? "baixa registrada"
              : desfazer.acao === "QUITADO" ? "quitado e encerrado" : "rejeitado"}.
          </span>
          <button type="button" style={btnDesfazer} onClick={desfazerAgora}>Desfazer (U)</button>
        </div>
      ) : null}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}
              >
                Fechar ✕
              </button>
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const faixas = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 };
const chipFaixa = {
  background: "#fff", border: "1px solid #cbd5e1", borderRadius: 999,
  padding: "5px 13px", fontSize: 12.5, fontWeight: 800, color: "#475569", cursor: "pointer",
};
const chipFaixaOn = { background: "#0f172a", borderColor: "#0f172a", color: "#fff" };
const dicaTeclado = { fontSize: 11.5, color: "#94a3b8", marginLeft: "auto" };
const avisoCorte = {
  margin: "0 0 10px", fontSize: 12.5, color: "#1e3a8a", background: "#eff6ff",
  border: "1px solid #bfdbfe", borderRadius: 8, padding: "9px 13px", maxWidth: 900,
};
const contexto = {
  margin: "0 0 12px", fontSize: 12.5, color: "#78350f", background: "#fffbeb",
  border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", maxWidth: 900,
};
const linkNome = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontWeight: 800, fontSize: 13.5, color: "#0f172a", textAlign: "left", textDecoration: "underline",
};
const sub = { fontSize: 11.5, color: "#64748b", marginTop: 2 };
const btnQuitar = {
  background: "#0f172a", color: "#fff", border: "none", borderRadius: 8,
  padding: "5px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer",
};
const caixaConf = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const txtConf = { fontSize: 12, color: "#334155" };
const inputMotivo = {
  border: "1px solid #cbd5e1", borderRadius: 8, padding: "4px 9px", fontSize: 12, minWidth: 190,
};
const btnOk = {
  background: "#16a34a", color: "#fff", border: "none", borderRadius: 8,
  padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer",
};
const btnNao = {
  background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8,
  padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer",
};
const toast = {
  position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 26,
  background: "#0f172a", color: "#fff", borderRadius: 12, padding: "11px 16px",
  display: "flex", gap: 14, alignItems: "center", fontSize: 13,
  boxShadow: "0 10px 30px rgba(15,23,42,.35)", zIndex: 200, maxWidth: "92vw",
};
const btnDesfazer = {
  background: "#facc15", color: "#0f172a", border: "none", borderRadius: 8,
  padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
};
