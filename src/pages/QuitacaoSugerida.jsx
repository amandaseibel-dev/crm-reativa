// Sugestao de quitacao: alunos cujo pagamento vinculado cobre o saldo em aberto.
//
// POR QUE EXISTE. Medido em 14 dias, a Amanda quitava 39 casos por dia na mao,
// um a um. Desde que o pagamento passou a ser vinculado ao aluno, o sistema
// sabe quanto cada um pagou -- entao da para apontar quem ja pagou tudo.
//
// NAO quita sozinho, de proposito. "Pagou mais do que deve" tambem acontece
// quando divida nova entrou depois de um pagamento antigo, e ai quitar seria
// apagar cobranca legitima. A tela sugere; quem decide e a gestao.
//
// O botao chama a MESMA funcao do "Quitar tudo" da ficha
// (quitar_e_encerrar_caso), entao o comportamento e identico ao manual.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataCurta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

export default function QuitacaoSugerida() {
  const [dias, setDias] = useState(30);
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [marcados, setMarcados] = useState(() => new Set());
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState(null);
  // Ficha na MESMA tela: sair para outra aba e voltar fazia perder a lista e o
  // que ja estava marcado. Aqui ela abre por cima, confere e fecha.
  const [fichaId, setFichaId] = useState(null);
  const [nomeCopiado, setNomeCopiado] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(""); setResultado(null); setMarcados(new Set());
    const { data, error } = await supabase.rpc("quitacao_sugerida", { p_dias: dias });
    if (error) setErro(error.message);
    setLinhas(data || []);
    setCarregando(false);
  }, [dias]);

  useEffect(() => { carregar(); }, [carregar]);

  const totalSaldo = useMemo(
    () => linhas.reduce((s, l) => s + Number(l.saldo || 0), 0), [linhas]);
  const saldoMarcado = useMemo(
    () => linhas.filter((l) => marcados.has(l.aluno_id)).reduce((s, l) => s + Number(l.saldo || 0), 0),
    [linhas, marcados]);

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  function alternar(id) {
    setMarcados((antes) => {
      const novo = new Set(antes);
      if (novo.has(id)) novo.delete(id); else novo.add(id);
      return novo;
    });
  }
  function marcarTodos() {
    setMarcados(marcados.size === linhas.length ? new Set() : new Set(linhas.map((l) => l.aluno_id)));
  }

  async function quitarMarcados() {
    const alvos = linhas.filter((l) => marcados.has(l.aluno_id));
    if (alvos.length === 0) return;
    if (!window.confirm(
      `Quitar ${alvos.length} aluno(s), somando ${moeda(saldoMarcado)} de saldo?\n\n` +
      `É a mesma ação do "Quitar tudo" da ficha, feita em lote. Fica registrado na ficha de cada um.`
    )) return;

    setProcessando(true);
    const ok = []; const falhou = [];
    // Um a um de proposito: se um falhar, os outros seguem, e o erro fica
    // identificado por aluno em vez de derrubar o lote inteiro.
    for (const a of alvos) {
      const { data, error } = await supabase.rpc("quitar_e_encerrar_caso", { p_aluno_id: a.aluno_id });
      if (error) falhou.push({ nome: a.nome, erro: error.message });
      else if (data && data.ok === false) falhou.push({ nome: a.nome, erro: data.motivo || "recusado" });
      else ok.push(a.nome);
    }
    setProcessando(false);
    setResultado({ ok: ok.length, falhou });
    carregar();
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Quitação sugerida</h1>
          <p style={S.sub}>
            Alunos cujo pagamento já cobre o saldo em aberto. O sistema aponta; quem quita é você.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} style={S.select}>
          <option value={7}>Pagamentos dos últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={60}>Últimos 60 dias</option>
          <option value={90}>Últimos 90 dias</option>
        </select>
        <button type="button" onClick={marcarTodos} style={S.btnGhost} disabled={!linhas.length}>
          {marcados.size === linhas.length && linhas.length ? "Desmarcar todos" : "Marcar todos"}
        </button>
        <button
          type="button"
          onClick={quitarMarcados}
          disabled={processando || marcados.size === 0}
          style={{ ...S.btnGhost, background: marcados.size ? "#15803d" : "#94a3b8" }}
        >
          {processando ? "Quitando…" : `Quitar ${marcados.size || ""} selecionado(s)`}
        </button>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{linhas.length} alunos</span>
          <span style={S.contadorValor}>{moeda(totalSaldo)}</span>
          {marcados.size ? <span style={S.contadorAcordos}>marcado: {moeda(saldoMarcado)}</span> : null}
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {resultado ? (
        <div style={{ ...S.erroBox, background: "#f0fdf4", color: "#166534", borderColor: "#bbf7d0" }}>
          {resultado.ok} quitado(s) com sucesso.
          {resultado.falhou.length ? ` ${resultado.falhou.length} falhou: ` +
            resultado.falhou.slice(0, 3).map((f) => `${f.nome} (${f.erro})`).join("; ") : ""}
        </div>
      ) : null}

      {!carregando && linhas.length === 0 ? (
        <p style={S.muted}>Nenhum aluno com pagamento cobrindo o saldo nesse período.</p>
      ) : null}

      <div style={S.cards}>
        {linhas.map((l) => (
          <div key={l.aluno_id} style={S.card}>
            <div style={S.cardHead}>
              <div style={{ ...S.cardHeadInfo, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={marcados.has(l.aluno_id)}
                  onChange={() => alternar(l.aluno_id)}
                  style={{ width: 17, height: 17, cursor: "pointer" }}
                />
                <span style={S.cardNome}>{l.nome}</span>
                <button
                  type="button"
                  onClick={() => copiarNome(l.nome)}
                  style={btnCopiarNome}
                  title="Copiar o nome do aluno"
                >
                  {nomeCopiado === l.nome ? "✓ Copiado" : "📋 Copiar"}
                </button>
                <span style={S.cardCpf}>
                  CPF {l.cpf || "-"} · {l.responsavel} · {l.qtd_pagamentos} pagamento(s) · último {dataCurta(l.ultimo_pagamento)}
                </span>
              </div>
              <div style={S.cardHeadDir}>
                <span style={colunaPagou}>pagou {moeda(l.pago)}</span>
                <span style={colunaDeve}>saldo {moeda(l.saldo)}</span>
                {Number(l.sobra) > 0.005 ? (
                  <span style={colunaSobra}>sobra {moeda(l.sobra)}</span>
                ) : null}
                <button type="button" onClick={() => setFichaId(l.aluno_id)} style={linkFicha}>
                  Abrir ficha
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => { setFichaId(null); carregar(); }}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
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

const btnCopiarNome = { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
const colunaPagou = { fontSize: 12.5, fontWeight: 800, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "4px 12px" };
const colunaDeve = { fontSize: 12.5, fontWeight: 800, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "4px 12px" };
const colunaSobra = { fontSize: 12, fontWeight: 700, color: "#475569", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 999, padding: "4px 10px" };
const linkFicha = { fontSize: 12.5, fontWeight: 700, color: "#1d4ed8", textDecoration: "none", border: "1px solid #bfdbfe", borderRadius: 8, padding: "6px 12px", background: "#eff6ff" };
