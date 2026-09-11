import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// Agenda pessoal e privada de cada usuario (RLS por e-mail). Trilhas +
// notas com status + plano de baixas (com nomes por hora e aviso) +
// registros operacionais (faltas/trocas/intercorrencias) editaveis.

const TIPOS = [
  { id: "IMPORTANTE", label: "Importante", emoji: "⭐", cor: "var(--rv-ambar-texto)", bg: "var(--rv-ambar-fundo)", borda: "var(--rv-ambar-borda)" },
  { id: "PENDENCIA", label: "Pendências", emoji: "⏳", cor: "var(--rv-vermelho-texto)", bg: "var(--rv-vermelho-fundo)", borda: "var(--rv-vermelho-borda)" },
  { id: "A_FAZER", label: "A fazer", emoji: "✅", cor: "var(--rv-azul-texto)", bg: "var(--rv-azul-fundo)", borda: "var(--rv-azul-borda)" },
];

const RECOR_LABEL = { NENHUMA: "", DIARIA: "Diária", SEMANAL: "Semanal", MENSAL: "Mensal" };
const RECOR_OPCOES = ["NENHUMA", "DIARIA", "SEMANAL", "MENSAL"];

const BAIXA_INICIO = 9;
const BAIXA_FIM = 18;
const BAIXA_POR_HORA = 6;

const STATUS_NOTA = [
  { id: "NOVA", label: "Nova", cor: "var(--rv-texto)", bg: "var(--rv-fundo-suave)" },
  { id: "MELHORAR", label: "Melhorar", cor: "var(--rv-ambar-texto)", bg: "var(--rv-ambar-fundo)" },
  { id: "ANALISAR", label: "Analisar", cor: "var(--rv-roxo)", bg: "var(--rv-roxo-fundo)" },
  { id: "EQUIPE", label: "Ver com a equipe", cor: "var(--rv-azul-texto)", bg: "var(--rv-azul-fundo)" },
  { id: "CONCLUIDO", label: "Concluído", cor: "var(--rv-verde-ok-texto)", bg: "var(--rv-verde-ok-fundo)" },
];
function statusNotaInfo(id) {
  return STATUS_NOTA.find((s) => s.id === id) || STATUS_NOTA[0];
}

const OPERACIONAL = [
  { id: "FALTA", label: "Falta", cor: "var(--rv-vermelho-texto)", bg: "var(--rv-vermelho-fundo)" },
  { id: "TROCA", label: "Troca de turno", cor: "var(--rv-azul-texto)", bg: "var(--rv-azul-fundo)" },
  { id: "INTERCORRENCIA", label: "Intercorrência", cor: "var(--rv-ambar-texto)", bg: "var(--rv-ambar-fundo)" },
];
const OP_TIPOS = ["FALTA", "TROCA", "INTERCORRENCIA"];
function opInfo(id) {
  return OPERACIONAL.find((o) => o.id === id) || OPERACIONAL[0];
}
function vazioOp() {
  return { operador: "", tipo: "FALTA", data: "", texto: "" };
}

function vazioForm() {
  return { texto: "", data: "", hora: "", recorrencia: "NENHUMA" };
}

function dataBR(iso) {
  if (!iso) return "";
  const p = String(iso).split("-");
  if (p.length === 3) return p[2] + "/" + p[1] + "/" + p[0];
  return iso;
}

export default function MinhaAgendaPessoal() {
  const [email, setEmail] = useState("");
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [novo, setNovo] = useState({ IMPORTANTE: vazioForm(), PENDENCIA: vazioForm(), A_FAZER: vazioForm() });
  const [novaNota, setNovaNota] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [baixas, setBaixas] = useState(null);
  const [novoOp, setNovoOp] = useState(vazioOp());
  const [operadores, setOperadores] = useState([]);
  const [editandoOpId, setEditandoOpId] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setEmail(data?.user?.email || "");
      await carregar();
      await carregarBaixas();
      await carregarOperadores();
    })();
  }, []);

  async function carregarOperadores() {
    const { data } = await supabase
      .from("usuarios")
      .select("nome, apelido, email")
      .eq("perfil", "operador")
      .eq("ativo", true)
      .order("nome");
    setOperadores(data || []);
  }

  async function adicionarOperacional() {
    const texto = String(novoOp.texto || "").trim();
    if (!novoOp.operador || !texto) { alert("Informe o operador e a descrição."); return; }
    setSalvando(true);
    const dados = {
      tipo: novoOp.tipo,
      conteudo: texto,
      operador_ref: novoOp.operador,
      data: novoOp.data || null,
      atualizado_em: new Date().toISOString(),
    };
    const q = editandoOpId
      ? supabase.from("agenda_pessoal").update(dados).eq("id", editandoOpId)
      : supabase.from("agenda_pessoal").insert(dados);
    const { error } = await q;
    setSalvando(false);
    if (error) { alert("Erro ao salvar: " + error.message); return; }
    setNovoOp(vazioOp());
    setEditandoOpId(null);
    carregar();
  }

  function editarOperacional(r) {
    setEditandoOpId(r.id);
    setNovoOp({ operador: r.operador_ref || "", tipo: r.tipo, data: r.data || "", texto: r.conteudo || "" });
  }

  async function carregarBaixas() {
    const { data, count } = await supabase
      .from("links_pagamento")
      .select("aluno_nome, aluno_cpf", { count: "exact" })
      .eq("status", "AGUARDANDO_BAIXA")
      .order("aluno_nome", { ascending: true })
      .limit(60);
    setBaixas({ total: count || 0, casos: data || [] });
  }

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("agenda_pessoal")
      .select("*")
      .order("concluido", { ascending: true })
      .order("data", { ascending: true, nullsFirst: false })
      .order("hora", { ascending: true, nullsFirst: false })
      .order("criado_em", { ascending: false });
    if (!error) setItens(data || []);
    setCarregando(false);
  }

  function setCampo(tipo, campo, valor) {
    setNovo((v) => ({ ...v, [tipo]: { ...v[tipo], [campo]: valor } }));
  }

  async function adicionar(tipo) {
    const f = novo[tipo];
    const conteudo = String(f.texto || "").trim();
    if (!conteudo) return;
    setSalvando(true);
    const { error } = await supabase.from("agenda_pessoal").insert({
      tipo,
      conteudo,
      data: f.data || null,
      hora: f.hora || null,
      recorrencia: f.recorrencia || "NENHUMA",
    });
    setSalvando(false);
    if (error) { alert("Erro ao salvar: " + error.message); return; }
    setNovo((v) => ({ ...v, [tipo]: vazioForm() }));
    carregar();
  }

  async function adicionarNota() {
    const conteudo = String(novaNota || "").trim();
    if (!conteudo) return;
    setSalvando(true);
    const { error } = await supabase.from("agenda_pessoal").insert({ tipo: "NOTA", conteudo, status_nota: "NOVA" });
    setSalvando(false);
    if (error) { alert("Erro ao salvar: " + error.message); return; }
    setNovaNota("");
    carregar();
  }

  async function mudarStatusNota(item, status) {
    const { error } = await supabase
      .from("agenda_pessoal")
      .update({ status_nota: status, atualizado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) { alert("Erro: " + error.message); return; }
    carregar();
  }

  async function alternarConcluido(item) {
    const { error } = await supabase
      .from("agenda_pessoal")
      .update({ concluido: !item.concluido, atualizado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) { alert("Erro: " + error.message); return; }
    carregar();
  }

  async function excluir(item) {
    const { error } = await supabase.from("agenda_pessoal").delete().eq("id", item.id);
    if (error) { alert("Erro ao excluir: " + error.message); return; }
    carregar();
  }

  const porTipo = useMemo(() => {
    const mapa = { IMPORTANTE: [], PENDENCIA: [], A_FAZER: [], NOTA: [] };
    itens.forEach((i) => { if (mapa[i.tipo]) mapa[i.tipo].push(i); });
    return mapa;
  }, [itens]);

  const hojeISO = new Date().toISOString().slice(0, 10);
  const notas = porTipo.NOTA;

  const registrosOp = useMemo(() => {
    return itens
      .filter((i) => OP_TIPOS.includes(i.tipo))
      .sort((a, b) => String(b.data || b.criado_em).localeCompare(String(a.data || a.criado_em)));
  }, [itens]);

  const planoBaixas = useMemo(() => {
    if (!baixas || baixas.total <= 0) return null;
    const total = baixas.total;
    const casos = baixas.casos || [];
    const maxBlocos = BAIXA_FIM - BAIXA_INICIO;
    const nBlocos = Math.min(maxBlocos, Math.ceil(total / BAIXA_POR_HORA));
    const blocos = [];
    let restante = total;
    for (let k = 0; k < nBlocos; k++) {
      const q = Math.min(BAIXA_POR_HORA, restante);
      const nomes = casos.slice(k * BAIXA_POR_HORA, k * BAIXA_POR_HORA + q).map((c) => c.aluno_nome || "Aluno");
      blocos.push({ ini: BAIXA_INICIO + k, fim: BAIXA_INICIO + k + 1, qtd: q, nomes });
      restante -= q;
    }
    return { total, blocos, restante };
  }, [baixas]);

  function h2(n) { return String(n).padStart(2, "0") + "h"; }

  function metaItem(i) {
    const partes = [];
    if (i.data) {
      let etiqueta = dataBR(i.data);
      if (i.data === hojeISO) etiqueta = "Hoje";
      partes.push(etiqueta);
    }
    if (i.hora) partes.push(String(i.hora).slice(0, 5));
    return partes.join(" · ");
  }

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Minha Agenda</h1>
          <p style={S.subtitulo}>Seu espaço pessoal e privado — só você vê. Importante, pendências, a fazer, ideias, plano de baixas e gestão da operação.</p>
        </div>
        <button style={S.botaoAtualizar} onClick={() => { carregar(); carregarBaixas(); }}>Atualizar</button>
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando sua agenda...</p>
      ) : (
        <>
          {planoBaixas && (
            <div style={S.avisoBaixa}>⚠️ Você tem {planoBaixas.total} baixa(s) para confirmar hoje — veja o plano por hora abaixo.</div>
          )}
          {planoBaixas && (
            <div style={S.baixaCard}>
              <div style={S.colunaTopo}>
                <span style={{ ...S.colunaTitulo, color: "var(--rv-teal-texto)" }}>🧾 Plano de baixas de hoje</span>
                <span style={S.contador}>{planoBaixas.total} na fila</span>
              </div>
              <div style={S.baixaSub}>Fila de confirmação/baixa · 6 casos por hora (10 min cada), das 9h às 18h. Calculado ao vivo.</div>
              <div style={S.baixaBlocos}>
                {planoBaixas.blocos.map((b) => (
                  <div key={b.ini} style={S.baixaBloco}>
                    <div style={S.baixaHora}>{h2(b.ini)}–{h2(b.fim)} · {b.qtd}</div>
                    <div style={S.baixaNomes}>
                      {b.nomes.map((n, i) => <div key={i} style={S.baixaNome} title={n}>{n}</div>)}
                    </div>
                  </div>
                ))}
              </div>
              {planoBaixas.restante > 0 && (
                <div style={S.baixaRestante}>Restam {planoBaixas.restante} para os próximos dias.</div>
              )}
            </div>
          )}
          <div style={S.grid}>
            {TIPOS.map((t) => {
              const lista = porTipo[t.id] || [];
              const abertos = lista.filter((i) => !i.concluido);
              const feitos = lista.filter((i) => i.concluido);
              const f = novo[t.id];
              return (
                <div key={t.id} style={{ ...S.coluna, background: t.bg, borderColor: t.borda }}>
                  <div style={S.colunaTopo}>
                    <span style={{ ...S.colunaTitulo, color: t.cor }}>{t.emoji} {t.label}</span>
                    <span style={S.contador}>{abertos.length}</span>
                  </div>

                  <div style={S.form}>
                    <input
                      style={S.input}
                      placeholder={"Adicionar em " + t.label + "..."}
                      value={f.texto}
                      onChange={(e) => setCampo(t.id, "texto", e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") adicionar(t.id); }}
                    />
                    <div style={S.formLinha}>
                      <input style={S.inputPeq} type="date" value={f.data} onChange={(e) => setCampo(t.id, "data", e.target.value)} title="Dia" />
                      <input style={S.inputPeq} type="time" value={f.hora} onChange={(e) => setCampo(t.id, "hora", e.target.value)} title="Horário" />
                      <select style={S.selectPeq} value={f.recorrencia} onChange={(e) => setCampo(t.id, "recorrencia", e.target.value)} title="Recorrência">
                        {RECOR_OPCOES.map((r) => <option key={r} value={r}>{r === "NENHUMA" ? "Sem repetir" : RECOR_LABEL[r]}</option>)}
                      </select>
                      <button style={{ ...S.botaoAdd, background: t.cor }} disabled={salvando} onClick={() => adicionar(t.id)}>Adicionar</button>
                    </div>
                  </div>

                  <div style={S.itens}>
                    {abertos.length === 0 && feitos.length === 0 && (
                      <div style={S.vazio}>Nada por aqui ainda.</div>
                    )}
                    {abertos.map((i) => {
                      const meta = metaItem(i);
                      const rec = i.recorrencia && i.recorrencia !== "NENHUMA" ? RECOR_LABEL[i.recorrencia] : "";
                      const atrasado = i.data && i.data < hojeISO;
                      return (
                        <div key={i.id} style={S.item}>
                          <input type="checkbox" checked={false} onChange={() => alternarConcluido(i)} style={S.check} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={S.itemTexto}>{i.conteudo}</span>
                            {(meta || rec) && (
                              <div style={S.metaLinha}>
                                {meta && <span style={{ ...S.metaData, color: atrasado ? "var(--rv-vermelho-texto)" : "var(--rv-texto)" }}>{atrasado ? "Atrasado · " : ""}{meta}</span>}
                                {rec && <span style={S.recChip}>🔁 {rec}</span>}
                              </div>
                            )}
                          </div>
                          <button style={S.excluir} title="Excluir" onClick={() => excluir(i)}>×</button>
                        </div>
                      );
                    })}
                    {feitos.length > 0 && <div style={S.feitosLabel}>Concluídos</div>}
                    {feitos.map((i) => (
                      <div key={i.id} style={{ ...S.item, opacity: 0.55 }}>
                        <input type="checkbox" checked={true} onChange={() => alternarConcluido(i)} style={S.check} />
                        <span style={{ ...S.itemTexto, flex: 1, textDecoration: "line-through" }}>{i.conteudo}</span>
                        <button style={S.excluir} title="Excluir" onClick={() => excluir(i)}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={S.notasCard}>
            <div style={S.colunaTopo}>
              <span style={{ ...S.colunaTitulo, color: "var(--rv-roxo-texto)" }}>📝 Notas, pensamentos e ideias</span>
              <span style={S.contador}>{notas.length}</span>
            </div>
            <div style={S.notaAdd}>
              <textarea
                style={S.textarea}
                placeholder="Escreva uma ideia, um lembrete, um pensamento..."
                value={novaNota}
                onChange={(e) => setNovaNota(e.target.value)}
              />
              <button style={S.botaoNota} disabled={salvando} onClick={adicionarNota}>Guardar nota</button>
            </div>
            <div style={S.notasGrid}>
              {notas.length === 0 && <div style={S.vazio}>Nenhuma nota ainda.</div>}
              {notas.map((n) => {
                const si = statusNotaInfo(n.status_nota);
                return (
                  <div key={n.id} style={S.notaCard}>
                    <button style={S.excluirNota} title="Excluir" onClick={() => excluir(n)}>×</button>
                    <span style={{ ...S.statusChip, color: si.cor, background: si.bg, borderColor: si.cor }}>{si.label}</span>
                    <div style={S.notaTexto}>{n.conteudo}</div>
                    <div style={S.notaRodape}>
                      <select style={S.statusSelect} value={n.status_nota || "NOVA"} onChange={(e) => mudarStatusNota(n, e.target.value)} title="Status da nota">
                        {STATUS_NOTA.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                      <span style={S.notaData}>{new Date(n.criado_em).toLocaleDateString("pt-BR")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={S.opCard}>
            <div style={S.colunaTopo}>
              <span style={{ ...S.colunaTitulo, color: "var(--rv-tinta)" }}>👥 Operação — faltas, trocas de turno e intercorrências</span>
              <span style={S.contador}>{registrosOp.length}</span>
            </div>
            <div style={S.opForm}>
              <input
                style={{ ...S.opInput, minWidth: 150 }}
                list="agenda-operadores"
                placeholder="Operador"
                value={novoOp.operador}
                onChange={(e) => setNovoOp((v) => ({ ...v, operador: e.target.value }))}
              />
              <datalist id="agenda-operadores">
                {operadores.map((o) => <option key={o.email} value={o.apelido || o.nome} />)}
              </datalist>
              <select style={S.opInput} value={novoOp.tipo} onChange={(e) => setNovoOp((v) => ({ ...v, tipo: e.target.value }))}>
                {OPERACIONAL.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <input style={S.opInput} type="date" value={novoOp.data} onChange={(e) => setNovoOp((v) => ({ ...v, data: e.target.value }))} title="Data" />
              <input
                style={{ ...S.opInput, flex: 1, minWidth: 200 }}
                placeholder="Descrição (ex.: falta justificada, troca com Fulano, atestado...)"
                value={novoOp.texto}
                onChange={(e) => setNovoOp((v) => ({ ...v, texto: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") adicionarOperacional(); }}
              />
              <button style={S.opBtn} disabled={salvando} onClick={adicionarOperacional}>{editandoOpId ? "Salvar" : "Registrar"}</button>
              {editandoOpId && <button style={S.opCancelar} onClick={() => { setEditandoOpId(null); setNovoOp(vazioOp()); }}>Cancelar</button>}
            </div>
            <div style={S.itens}>
              {registrosOp.length === 0 && <div style={S.vazio}>Nenhum registro ainda.</div>}
              {registrosOp.map((r) => {
                const oi = opInfo(r.tipo);
                return (
                  <div key={r.id} style={S.item}>
                    <span style={{ ...S.statusChip, color: oi.cor, background: oi.bg, borderColor: oi.cor, marginTop: 1 }}>{oi.label}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={S.itemTexto}><strong>{r.operador_ref || "-"}</strong> — {r.conteudo}</span>
                      {r.data && <div style={S.metaLinha}><span style={{ ...S.metaData, color: "var(--rv-texto)" }}>{dataBR(r.data)}</span></div>}
                    </div>
                    <button style={S.opEditar} title="Editar" onClick={() => editarOperacional(r)}>editar</button>
                    <button style={S.excluir} title="Excluir" onClick={() => excluir(r)}>×</button>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--rv-fundo)", minHeight: "100%", color: "var(--rv-tinta)" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 20, flexWrap: "wrap" },
  titulo: { margin: 0, color: "var(--rv-tinta)", fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "6px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5, maxWidth: 720 },
  botaoAtualizar: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  muted: { color: "var(--rv-texto-suave)", fontSize: 14 },
  baixaCard: { background: "var(--rv-verde-ok-fundo)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 16, padding: 16, marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 },
  baixaSub: { fontSize: 12.5, color: "var(--rv-texto)" },
  baixaBlocos: { display: "flex", gap: 10, flexWrap: "wrap" },
  baixaBloco: { background: "var(--rv-superficie)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 12, padding: "10px 12px", minWidth: 160, maxWidth: 220 },
  baixaHora: { fontSize: 13, fontWeight: 800, color: "var(--rv-teal-texto)" },
  baixaQtd: { fontSize: 12.5, color: "var(--rv-texto-forte)", marginTop: 3, fontWeight: 600 },
  baixaNomes: { marginTop: 6, display: "flex", flexDirection: "column", gap: 2 },
  baixaNome: { fontSize: 12, color: "var(--rv-texto-forte)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  avisoBaixa: { background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", color: "var(--rv-ambar-texto)", borderRadius: 12, padding: "12px 16px", marginBottom: 12, fontSize: 13.5, fontWeight: 700 },
  baixaRestante: { fontSize: 12.5, color: "var(--rv-ambar-texto)", fontWeight: 700 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginBottom: 18 },
  coluna: { border: "1px solid", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 12 },
  colunaTopo: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  colunaTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800 },
  contador: { background: "var(--rv-superficie)", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700, color: "var(--rv-texto)", border: "1px solid var(--rv-borda)" },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  formLinha: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
  input: { border: "1px solid var(--rv-borda-forte)", borderRadius: 10, padding: "9px 11px", fontSize: 14, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none" },
  inputPeq: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 8px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none" },
  selectPeq: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "6px 8px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none" },
  botaoAdd: { color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", marginLeft: "auto" },
  itens: { display: "flex", flexDirection: "column", gap: 8 },
  item: { display: "flex", alignItems: "flex-start", gap: 8, background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 10, padding: "9px 11px" },
  check: { marginTop: 3, width: 16, height: 16, cursor: "pointer", flexShrink: 0 },
  itemTexto: { fontSize: 14, color: "var(--rv-tinta)", wordBreak: "break-word", lineHeight: 1.4, display: "block" },
  metaLinha: { display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" },
  metaData: { fontSize: 12, fontWeight: 700 },
  recChip: { fontSize: 11, fontWeight: 700, color: "var(--rv-roxo-texto)", background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 999, padding: "1px 8px" },
  excluir: { background: "transparent", border: "none", color: "var(--rv-texto-fraco)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 0, flexShrink: 0 },
  feitosLabel: { fontSize: 11, fontWeight: 700, color: "var(--rv-texto-fraco)", textTransform: "uppercase", marginTop: 4 },
  vazio: { color: "var(--rv-texto-fraco)", fontSize: 13, padding: "6px 2px" },
  notasCard: { background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 16, padding: 18, display: "flex", flexDirection: "column", gap: 12 },
  notaAdd: { display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" },
  textarea: { flex: 1, minWidth: 240, minHeight: 70, border: "1px solid var(--rv-borda-forte)", borderRadius: 10, padding: "10px 12px", fontSize: 14, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none", resize: "vertical", fontFamily: "inherit" },
  botaoNota: { background: "#4338ca", color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 700, cursor: "pointer", height: 42 },
  notasGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 },
  notaCard: { position: "relative", background: "var(--rv-superficie)", border: "1px solid var(--rv-roxo-borda)", borderRadius: 12, padding: "12px 14px", boxShadow: "0 1px 2px rgba(16,24,40,0.05)", display: "flex", flexDirection: "column", gap: 8 },
  statusChip: { alignSelf: "flex-start", fontSize: 10.5, fontWeight: 800, border: "1px solid", borderRadius: 999, padding: "1px 9px", textTransform: "uppercase", letterSpacing: "0.02em" },
  notaTexto: { fontSize: 14, color: "var(--rv-tinta)", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45 },
  notaRodape: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 2 },
  statusSelect: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "5px 7px", fontSize: 12, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none" },
  notaData: { fontSize: 11, color: "var(--rv-texto-fraco)" },
  excluirNota: { position: "absolute", top: 6, right: 8, background: "transparent", border: "none", color: "var(--rv-texto-fraco)", fontSize: 18, cursor: "pointer", lineHeight: 1 },
  opCard: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 16, padding: 18, marginTop: 18, display: "flex", flexDirection: "column", gap: 12 },
  opForm: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  opInput: { border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "8px 10px", fontSize: 13, background: "var(--rv-superficie)", color: "var(--rv-tinta)", outline: "none" },
  opBtn: { background: "var(--rv-botao-escuro)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  opCancelar: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  opEditar: { background: "transparent", border: "none", color: "var(--rv-azul)", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "0 4px", flexShrink: 0 },
};
