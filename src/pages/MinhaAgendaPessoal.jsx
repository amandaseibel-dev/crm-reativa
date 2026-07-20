import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// Agenda pessoal e privada de cada usuario (RLS por e-mail no banco: cada um
// so ve o que e seu). Quatro trilhas: Importante, Pendencia, A fazer e Notas
// (pensamentos e ideias). Nada aqui toca a base operacional.

const TIPOS = [
  { id: "IMPORTANTE", label: "Importante", emoji: "⭐", cor: "#b45309", bg: "#fffbeb", borda: "#fde68a" },
  { id: "PENDENCIA", label: "Pendências", emoji: "⏳", cor: "#b91c1c", bg: "#fef2f2", borda: "#fecaca" },
  { id: "A_FAZER", label: "A fazer", emoji: "✅", cor: "#1d4ed8", bg: "#eff6ff", borda: "#bfdbfe" },
];

export default function MinhaAgendaPessoal() {
  const [email, setEmail] = useState("");
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [novoTexto, setNovoTexto] = useState({ IMPORTANTE: "", PENDENCIA: "", A_FAZER: "" });
  const [novaNota, setNovaNota] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || "";
      setEmail(mail);
      await carregar();
    })();
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("agenda_pessoal")
      .select("*")
      .order("concluido", { ascending: true })
      .order("criado_em", { ascending: false });
    if (!error) setItens(data || []);
    setCarregando(false);
  }

  async function adicionar(tipo, texto) {
    const conteudo = String(texto || "").trim();
    if (!conteudo) return;
    setSalvando(true);
    const { error } = await supabase.from("agenda_pessoal").insert({ tipo, conteudo });
    setSalvando(false);
    if (error) { alert("Erro ao salvar: " + error.message); return; }
    if (tipo === "NOTA") setNovaNota("");
    else setNovoTexto((v) => ({ ...v, [tipo]: "" }));
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

  const notas = porTipo.NOTA;

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Minha Agenda</h1>
          <p style={S.subtitulo}>Seu espaço pessoal e privado — só você vê. Organize o importante, as pendências, o que tem a fazer e guarde suas ideias.</p>
        </div>
        <button style={S.botaoAtualizar} onClick={carregar}>Atualizar</button>
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando sua agenda...</p>
      ) : (
        <>
          <div style={S.grid}>
            {TIPOS.map((t) => {
              const lista = porTipo[t.id] || [];
              const abertos = lista.filter((i) => !i.concluido);
              const feitos = lista.filter((i) => i.concluido);
              return (
                <div key={t.id} style={{ ...S.coluna, background: t.bg, borderColor: t.borda }}>
                  <div style={S.colunaTopo}>
                    <span style={{ ...S.colunaTitulo, color: t.cor }}>{t.emoji} {t.label}</span>
                    <span style={S.contador}>{abertos.length}</span>
                  </div>

                  <div style={S.addLinha}>
                    <input
                      style={S.input}
                      placeholder={"Adicionar em " + t.label + "..."}
                      value={novoTexto[t.id]}
                      onChange={(e) => setNovoTexto((v) => ({ ...v, [t.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") adicionar(t.id, novoTexto[t.id]); }}
                    />
                    <button style={{ ...S.botaoAdd, background: t.cor }} disabled={salvando} onClick={() => adicionar(t.id, novoTexto[t.id])}>+</button>
                  </div>

                  <div style={S.itens}>
                    {abertos.length === 0 && feitos.length === 0 && (
                      <div style={S.vazio}>Nada por aqui ainda.</div>
                    )}
                    {abertos.map((i) => (
                      <div key={i.id} style={S.item}>
                        <input type="checkbox" checked={false} onChange={() => alternarConcluido(i)} style={S.check} />
                        <span style={S.itemTexto}>{i.conteudo}</span>
                        <button style={S.excluir} title="Excluir" onClick={() => excluir(i)}>×</button>
                      </div>
                    ))}
                    {feitos.length > 0 && <div style={S.feitosLabel}>Concluídos</div>}
                    {feitos.map((i) => (
                      <div key={i.id} style={{ ...S.item, opacity: 0.55 }}>
                        <input type="checkbox" checked={true} onChange={() => alternarConcluido(i)} style={S.check} />
                        <span style={{ ...S.itemTexto, textDecoration: "line-through" }}>{i.conteudo}</span>
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
              <span style={{ ...S.colunaTitulo, color: "#4338ca" }}>📝 Notas, pensamentos e ideias</span>
              <span style={S.contador}>{notas.length}</span>
            </div>
            <div style={S.notaAdd}>
              <textarea
                style={S.textarea}
                placeholder="Escreva uma ideia, um lembrete, um pensamento..."
                value={novaNota}
                onChange={(e) => setNovaNota(e.target.value)}
              />
              <button style={S.botaoNota} disabled={salvando} onClick={() => adicionar("NOTA", novaNota)}>Guardar nota</button>
            </div>
            <div style={S.notasGrid}>
              {notas.length === 0 && <div style={S.vazio}>Nenhuma nota ainda.</div>}
              {notas.map((n) => (
                <div key={n.id} style={S.notaCard}>
                  <button style={S.excluirNota} title="Excluir" onClick={() => excluir(n)}>×</button>
                  <div style={S.notaTexto}>{n.conteudo}</div>
                  <div style={S.notaData}>{new Date(n.criado_em).toLocaleString("pt-BR")}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 20, flexWrap: "wrap" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "6px 0 0", color: "#8a93a3", fontSize: 13.5, maxWidth: 620 },
  botaoAtualizar: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  muted: { color: "#64748b", fontSize: 14 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 18 },
  coluna: { border: "1px solid", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 12 },
  colunaTopo: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  colunaTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800 },
  contador: { background: "#fff", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700, color: "#475569", border: "1px solid #e2e8f0" },
  addLinha: { display: "flex", gap: 8 },
  input: { flex: 1, border: "1px solid #cbd5e1", borderRadius: 10, padding: "9px 11px", fontSize: 14, background: "#fff", outline: "none" },
  botaoAdd: { color: "#fff", border: "none", borderRadius: 10, width: 40, fontSize: 20, fontWeight: 700, cursor: "pointer" },
  itens: { display: "flex", flexDirection: "column", gap: 8 },
  item: { display: "flex", alignItems: "flex-start", gap: 8, background: "#fff", border: "1px solid #eef2f6", borderRadius: 10, padding: "9px 11px" },
  check: { marginTop: 3, width: 16, height: 16, cursor: "pointer", flexShrink: 0 },
  itemTexto: { flex: 1, fontSize: 14, color: "#0f172a", wordBreak: "break-word", lineHeight: 1.4 },
  excluir: { background: "transparent", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 0 },
  feitosLabel: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginTop: 4 },
  vazio: { color: "#94a3b8", fontSize: 13, padding: "6px 2px" },
  notasCard: { background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 16, padding: 18, display: "flex", flexDirection: "column", gap: 12 },
  notaAdd: { display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" },
  textarea: { flex: 1, minWidth: 240, minHeight: 70, border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 12px", fontSize: 14, background: "#fff", outline: "none", resize: "vertical", fontFamily: "inherit" },
  botaoNota: { background: "#4338ca", color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 700, cursor: "pointer", height: 42 },
  notasGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 },
  notaCard: { position: "relative", background: "#fff", border: "1px solid #e0e7ff", borderRadius: 12, padding: "12px 14px", boxShadow: "0 1px 2px rgba(16,24,40,0.05)" },
  notaTexto: { fontSize: 14, color: "#0f172a", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45 },
  notaData: { fontSize: 11, color: "#94a3b8", marginTop: 8 },
  excluirNota: { position: "absolute", top: 6, right: 8, background: "transparent", border: "none", color: "#c4c9d4", fontSize: 18, cursor: "pointer", lineHeight: 1 },
};
