import { useEffect, useState } from "react";
import { supabase } from "../services/supabase"; import Alunos from "./Aluno";
import { OPERADORES_POR_EMAIL } from "../utils/operadores";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function StatusChip({ ok, texto }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11.5,
        fontWeight: 700,
        padding: "3px 10px",
        borderRadius: 999,
        color: ok ? "#0f7a4f" : "#b91c1c",
        background: ok ? "#eff6ff" : "#fef2f2",
        border: `1px solid ${ok ? "#c7d7fe" : "#fecaca"}`,
      }}
    >
      {ok ? "✅" : "⚠️"} {texto}
    </span>
  );
}

export default function SaudeDaBase() {
  const [carregando, setCarregando] = useState(true);
  const [dados, setDados] = useState(null);
  const [tendencia, setTendencia] = useState([]);
  const [modalCategoria, setModalCategoria] = useState(null);
  const [modalLista, setModalLista] = useState([]);
  const [carregandoModal, setCarregandoModal] = useState(false);
  const [enviandoMassa, setEnviandoMassa] = useState(false);
  const [msg, setMsg] = useState("");
  const [fidelizacaoVencida, setFidelizacaoVencida] = useState([]);
  const [liberandoFidelizacao, setLiberandoFidelizacao] = useState(false); const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase.rpc("saude_da_base");
    if (!error) setDados(data);
    const { data: t } = await supabase.rpc("saude_base_tendencia");
    setTendencia((t || []).slice().reverse());
    const { data: f } = await supabase.rpc("casos_elegiveis_liberacao_fidelizacao");
    setFidelizacaoVencida(f || []);
    setCarregando(false);
  }

  async function liberarFidelizacaoVencida() {
    setLiberandoFidelizacao(true);
    const { data, error } = await supabase.rpc("liberar_casos_fidelizacao_vencida");
    setLiberandoFidelizacao(false);
    setMsg(error ? "Erro: " + error.message : `${data} caso(s) liberado(s) pro receptivo por prazo de fidelização vencido.`);
    setTimeout(() => setMsg(""), 6000);
    carregar();
  }

  async function abrirCategoria(categoria, rotulo) {
    setModalCategoria(rotulo);
    setCarregandoModal(true);
    const { data } = await supabase.rpc("saude_base_lista", { p_categoria: categoria });
    setModalLista(data || []);
    setCarregandoModal(false);
  }

  async function enviarCriticosParaFila() {
    setEnviandoMassa(true);
    const { data, error } = await supabase.rpc("enviar_criticos_para_conferencia", { p_limite: 100 });
    setEnviandoMassa(false);
    setMsg(error ? "Erro: " + error.message : `${data} casos enviados pra Fila de Conferência.`);
    setTimeout(() => setMsg(""), 5000);
  }

  async function gerarAvisoSemanal() {
    const texto = `Panorama da base nesta semana: score de saúde em ${dados.score}%, ${dados.criticos_count} casos com múltiplos problemas de dado, ${dados.sem_valor} sem valor calculado e ${dados.sem_telefone} sem telefone. Confira em Saúde da Base.`;
    await supabase.from("avisos").insert({
      emoji: "🩺",
      titulo: "Panorama semanal da Saúde da Base",
      mensagem: texto,
      ativo: true,
    });
    setMsg("Aviso semanal criado — vai aparecer pra equipe.");
    setTimeout(() => setMsg(""), 5000);
  }

  if (carregando || !dados) {
    return <div style={estilos.container}>Carregando saúde da base...</div>;
  }

  const geradoEm = dados.gerado_em ? new Date(dados.gerado_em).toLocaleString("pt-BR") : "-";
  const scoreCor = dados.score >= 80 ? "#16a34a" : dados.score >= 50 ? "#d97706" : "#dc2626";
  const maxTendencia = Math.max(1, ...tendencia.map((t) => Number(t.score) || 0));

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>🩺 Saúde da Base</h1>
          <p style={estilos.subtitulo}>Panorama rápido pra saber se está tudo em ordem, sem precisar perguntar.</p>
        </div>
        <button style={estilos.botaoAtualizar} onClick={carregar}>
          Atualizar
        </button>
      </div>
      <p style={estilos.geradoEm}>Calculado agora: {geradoEm}</p>

      {msg && <div style={estilos.msg}>{msg}</div>}

      <div style={estilos.scoreCard}>
        <div style={estilos.scoreLado}>
          <span style={estilos.scoreLabel}>SCORE DE SAÚDE DA BASE</span>
          <span style={{ ...estilos.scoreNumero, color: scoreCor }}>{dados.score}%</span>
          <span style={estilos.scoreSub}>% de alunos sem nenhum problema de dado pendente</span>
        </div>
        {tendencia.length > 1 && (
          <div style={estilos.tendenciaWrap}>
            <span style={estilos.tendenciaLabel}>Últimos {tendencia.length} dias</span>
            <div style={estilos.tendenciaBarras}>
              {tendencia.map((t) => (
                <div
                  key={t.dia}
                  title={`${t.dia}: ${t.score}%`}
                  style={{
                    ...estilos.tendenciaBarra,
                    height: `${Math.max(4, (Number(t.score) / maxTendencia) * 44)}px`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Checagens automáticas</h3>
        <div style={estilos.linhaChips}>
          <StatusChip ok={dados.cpf_duplicado === 0} texto={dados.cpf_duplicado === 0 ? "Sem CPF duplicado" : `${dados.cpf_duplicado} CPF duplicado`} />
          <StatusChip ok={dados.casos_linhas_duplicadas === 0} texto={dados.casos_linhas_duplicadas === 0 ? "Sem duplicidade em casos" : `${dados.casos_linhas_duplicadas} aluno duplicado em casos`} />
          <StatusChip ok={dados.teto_estourado === 0} texto={dados.teto_estourado === 0 ? "Ninguém acima do teto" : `${dados.teto_estourado} operador(es) acima de 500`} />
          <StatusChip ok={dados.maior_desvio <= 500} texto={`Maior desvio de média: ${moeda(dados.maior_desvio)}`} />
        </div>
      </div>

      <div style={estilos.gridResumo}>
        <button type="button" style={estilos.cardValor} onClick={() => {}}>
          <span style={estilos.numeroValor}>{(dados.total_alunos || 0).toLocaleString("pt-BR")}</span>
          <span style={estilos.labelValor}>Total de alunos na base</span>
        </button>
        <button
          type="button"
          style={estilos.cardValor}
          onClick={() => abrirCategoria("sem_casos", "Sem nenhum registro em casos")}
        >
          <span style={estilos.numeroValor}>
            {(dados.alunos_sem_casos || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.alunos_sem_casos / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>Sem nenhum registro em casos — clique pra ver a lista</span>
        </button>
        <button
          type="button"
          style={{ ...estilos.cardValor, background: dados.sem_valor > 0 ? "#fef7f0" : undefined, borderColor: dados.sem_valor > 0 ? "#fde3cc" : undefined }}
          onClick={() => abrirCategoria("sem_valor", "Livres sem valor calculado")}
        >
          <span style={{ ...estilos.numeroValor, color: dados.sem_valor > 0 ? "#c2410c" : undefined }}>
            {(dados.sem_valor || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.sem_valor / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>Livres sem valor calculado — clique pra ver a lista</span>
        </button>
        <button
          type="button"
          style={{ ...estilos.cardValor, background: dados.sem_telefone > 0 ? "#fef7f0" : undefined, borderColor: dados.sem_telefone > 0 ? "#fde3cc" : undefined }}
          onClick={() => abrirCategoria("sem_telefone", "Sem telefone cadastrado")}
        >
          <span style={{ ...estilos.numeroValor, color: dados.sem_telefone > 0 ? "#c2410c" : undefined }}>
            {(dados.sem_telefone || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={estilos.percentual}> ({((dados.sem_telefone / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>Sem telefone cadastrado — clique pra ver a lista</span>
        </button>
        <div style={{ ...estilos.cardValor, background: "#eff6ff", borderColor: "#c7d7fe" }}>
          <span style={{ ...estilos.numeroValor, color: "#0f7a4f" }}>
            {(dados.livre_com_valor || 0).toLocaleString("pt-BR")}
            {dados.total_alunos > 0 && (
              <span style={{ ...estilos.percentual, color: "#0f7a4f" }}> ({((dados.livre_com_valor / dados.total_alunos) * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span style={estilos.labelValor}>
            Livres com valor (elegíveis) — <a href="/acoes-massivas" style={estilos.link}>ir pra Ações Massivas</a>
          </span>
        </div>
      </div>

      <div style={{ ...estilos.card, borderColor: "#fde3cc", background: "#fffaf5" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
          <h3 style={{ ...estilos.tituloBloco, margin: 0 }}>
            🎯 Mais críticos — {(dados.criticos_count || 0).toLocaleString("pt-BR")} casos com 2+ problemas ao mesmo tempo
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={estilos.botaoSecundario} onClick={gerarAvisoSemanal}>
              📢 Gerar aviso semanal
            </button>
            <button style={estilos.botaoAcao} onClick={enviarCriticosParaFila} disabled={enviandoMassa}>
              {enviandoMassa ? "Enviando..." : "🚀 Mandar 100 mais críticos pra Fila de Conferência"}
            </button>
          </div>
        </div>
        <p style={estilos.subtituloBloco}>
          Esses são os casos "mais perdidos" — sem telefone, sem valor e/ou sem nenhum registro, ao mesmo tempo.
          Quanto mais problemas juntos, mais no topo da lista.
        </p>
        <table style={estilos.tabela}>
          <thead>
            <tr>
              <th style={estilos.th}>Nome</th>
              <th style={estilos.th}>CPF</th>
              <th style={estilos.thNum}>Problemas</th>
            </tr>
          </thead>
          <tbody>
            {(dados.criticos || []).slice(0, 15).map((c) => (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setFichaId(c.id)}>
                <td style={estilos.td}>{c.nome || "-"}</td>
                <td style={estilos.td}>{c.cpf || "-"}</td>
                <td style={estilos.tdNum}>
                  {[c.sem_tel && "sem telefone", c.sem_val && "sem valor", c.sem_caso && "sem caso"].filter(Boolean).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(dados.criticos || []).length > 15 && (
          <p style={{ fontSize: 12, color: "#8a93a3", marginTop: 8 }}>
            Mostrando os 15 primeiros de {dados.criticos.length}.
          </p>
        )}
      </div>

      {fidelizacaoVencida.length > 0 && (
        <div style={{ ...estilos.card, borderColor: "#fde3cc", background: "#fffaf5" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
            <h3 style={{ ...estilos.tituloBloco, margin: 0 }}>
              📅 Fidelização vencida — {fidelizacaoVencida.length} caso(s) sem primeiro acionamento no prazo
            </h3>
            <button style={estilos.botaoAcao} onClick={liberarFidelizacaoVencida} disabled={liberandoFidelizacao}>
              {liberandoFidelizacao ? "Liberando..." : "🔓 Liberar todos pro receptivo"}
            </button>
          </div>
          <p style={estilos.subtituloBloco}>
            Casos que já estavam com o operador antes de 13/07 tinham até 23/07 pra ser acionados; quem foi assumido
            depois de 13/07 tem 10 dias corridos desde a atribuição. Passou do prazo sem nenhum acionamento — pode liberar.
          </p>
          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Nome</th>
                <th style={estilos.th}>Operador</th>
                <th style={estilos.th}>Prazo</th>
              </tr>
            </thead>
            <tbody>
              {fidelizacaoVencida.slice(0, 15).map((f) => (
                <tr key={f.aluno_id} style={{ cursor: "pointer" }} onClick={() => setFichaId(f.aluno_id)}>
                  <td style={estilos.td}>{f.nome || "-"}</td>
                  <td style={estilos.td}>{f.responsavel_atual_nome || "-"}</td>
                  <td style={estilos.tdNum}>{new Date(f.prazo_limite).toLocaleDateString("pt-BR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fidelizacaoVencida.length > 15 && (
            <p style={{ fontSize: 12, color: "#8a93a3", marginTop: 8 }}>Mostrando os 15 primeiros de {fidelizacaoVencida.length}.</p>
          )}
        </div>
      )}

      <div style={estilos.card}>
        <h3 style={estilos.tituloBloco}>Equilíbrio entre operadores</h3>
        <p style={estilos.subtituloBloco}>
          Média geral da equipe: <strong>{moeda(dados.media_geral)}</strong> · Maior desvio: <strong>{moeda(dados.maior_desvio)}</strong>
        </p>
        <table style={estilos.tabela}>
          <thead>
            <tr>
              <th style={estilos.th}>Operador</th>
              <th style={estilos.thNum}>Qtd. de casos</th>
              <th style={estilos.thNum}>Valor médio</th>
              <th style={estilos.thNum}>Desvio da média</th>
            </tr>
          </thead>
          <tbody>
            {(dados.operadores || []).map((op) => {
              const desvio = Number(op.media) - Number(dados.media_geral);
              return (
                <tr key={op.operador_email}>
                  <td style={estilos.td}>{OPERADORES_POR_EMAIL[op.operador_email] || op.operador_email}</td>
                  <td style={{ ...estilos.tdNum, color: op.qtd > 500 ? "#b91c1c" : op.qtd < 450 ? "#d97706" : undefined, fontWeight: 700 }}>
                    {op.qtd}
                  </td>
                  <td style={estilos.tdNum}>{moeda(op.media)}</td>
                  <td style={{ ...estilos.tdNum, color: Math.abs(desvio) > 500 ? "#b91c1c" : "#8a93a3" }}>
                    {desvio >= 0 ? "+" : ""}{moeda(desvio)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {fichaId && (<div style={estilos.modalOverlay} onClick={() => setFichaId(null)}><div style={{ ...estilos.modalBox, maxWidth: 1100 }} onClick={(e) => e.stopPropagation()}><div style={estilos.modalTopo}><h3 style={{ ...estilos.tituloBloco, margin: 0 }}>Ficha do aluno</h3><button style={estilos.modalFechar} onClick={() => setFichaId(null)}>✕</button></div><Alunos fichaEmbedId={fichaId} /></div></div>)} {modalCategoria && (
        <div style={estilos.modalOverlay} onClick={() => setModalCategoria(null)}>
          <div style={estilos.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={estilos.modalTopo}>
              <h3 style={{ ...estilos.tituloBloco, margin: 0 }}>{modalCategoria}</h3>
              <button style={estilos.modalFechar} onClick={() => setModalCategoria(null)}>✕</button>
            </div>
            {carregandoModal ? (
              <p style={estilos.subtituloBloco}>Carregando...</p>
            ) : (
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Nome</th>
                    <th style={estilos.th}>CPF</th>
                    <th style={estilos.th}>Telefone</th>
                  </tr>
                </thead>
                <tbody>
                  {modalLista.map((a) => (
                    <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => setFichaId(a.id)}>
                      <td style={estilos.td}>{a.nome || "-"}</td>
                      <td style={estilos.td}>{a.cpf || "-"}</td>
                      <td style={estilos.td}>{a.telefone || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {modalLista.length === 300 && (
              <p style={{ fontSize: 12, color: "#8a93a3", marginTop: 8 }}>Mostrando os primeiros 300.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 6, flexWrap: "wrap" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5 },
  geradoEm: { margin: "0 0 18px", color: "#98a2b3", fontSize: 12 },
  botaoAtualizar: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  card: { background: "#fff", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid #edf0f5", marginBottom: 18 },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "#0d1321" },
  subtituloBloco: { margin: "0 0 14px", fontSize: 13, color: "#475569" },
  linhaChips: { display: "flex", gap: 10, flexWrap: "wrap" },
  gridResumo: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 },
  cardValor: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 2px rgba(16,24,40,0.04)", transition: "box-shadow 0.15s ease, transform 0.15s ease" },
  numeroValor: { fontFamily: FONTE_TITULO, fontSize: 24, fontWeight: 800, color: "#0d1321" },
  labelValor: { fontSize: 12.5, color: "#8a93a3", fontWeight: 600 },
  percentual: { fontSize: 14, fontWeight: 700, color: "#8a93a3" },
  link: { color: "#1e40af", fontWeight: 700 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "9px 10px", borderBottom: "1px solid #f2f4f7", fontWeight: 700 },
  tdNum: { padding: "9px 10px", borderBottom: "1px solid #f2f4f7", textAlign: "right" },
  msg: { background: "#ecfdf5", border: "1px solid #bdeed4", color: "#0b7d54", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 13, fontWeight: 700 },
  scoreCard: { background: "#fff", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid #edf0f5", marginBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 },
  scoreLado: { display: "flex", flexDirection: "column", gap: 4 },
  scoreLabel: { fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", color: "#8a93a3" },
  scoreNumero: { fontFamily: FONTE_TITULO, fontSize: 42, fontWeight: 800, letterSpacing: "-0.02em" },
  scoreSub: { fontSize: 12.5, color: "#8a93a3" },
  tendenciaWrap: { display: "flex", flexDirection: "column", gap: 6 },
  tendenciaLabel: { fontSize: 11, fontWeight: 700, color: "#8a93a3" },
  tendenciaBarras: { display: "flex", alignItems: "flex-end", gap: 3, height: 44 },
  tendenciaBarra: { width: 6, borderRadius: 2, background: "#2563eb" },
  botaoAcao: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "9px 16px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  botaoSecundario: { background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 10, padding: "9px 16px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
  modalBox: { background: "#fff", borderRadius: 16, padding: 22, maxWidth: 640, width: "100%", maxHeight: "80vh", overflowY: "auto" },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  modalFechar: { background: "#f1f5f9", border: "none", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 14 },
};
