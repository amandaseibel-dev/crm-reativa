import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Contatos do aluno.
//
// O QUE MUDOU E POR QUÊ: o campo do telefone do aluno era uma casa só. Salvar
// um número novo apagava o anterior, e quando o operador ligava e não era a
// pessoa, ele apagava o número -- junto ia a informação de que aquele telefone
// é inválido, e na importação seguinte o número voltava.
//
// Agora os contatos do aluno (telefones e e-mails) ACUMULAM em `aluno_contatos`:
// número novo entra ao lado do antigo, e "não é a pessoa" vira invalidado, com
// autor e motivo, sem apagar nada.
//
// Os RESPONSÁVEIS continuam onde estavam, em `telefone_resp1`/`resp2`, porque
// carregam o nome de quem é junto -- decisão da Amanda.

function soDigitos(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 11 && !d.startsWith("55")) d = "55" + d;
  return d;
}

function exibirTelefone(valor) {
  const d = soDigitos(valor);
  if (!d.startsWith("55")) return valor;
  const ddd = d.slice(2, 4);
  const resto = d.slice(4);
  if (resto.length === 9) return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
  if (resto.length === 8) return `(${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
  return valor;
}

const ROTULO_ORIGEM = {
  cadastro: "Cadastro",
  prime: "Prime",
  operador: "Operador",
  importacao: "Importação",
  whatsapp: "WhatsApp",
};

export default function TelefonesAluno({ aluno }) {
  const [contatos, setContatos] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [novoTel, setNovoTel] = useState("");
  const [novoMail, setNovoMail] = useState("");
  const [msg, setMsg] = useState("");

  const [resp, setResp] = useState({ nome_resp1: "", telefone_resp1: "", nome_resp2: "", telefone_resp2: "" });
  const [salvandoResp, setSalvandoResp] = useState(false);

  const carregar = useCallback(async () => {
    if (!aluno?.id) return;
    setCarregando(true);
    const { data, error } = await supabase
      .from("aluno_contatos")
      .select("id, tipo, valor, valor_exibicao, origem, principal, valido, invalidado_em, invalidado_por_email, motivo_invalidacao")
      .eq("aluno_id", aluno.id)
      // Válidos primeiro, principal no topo, e os invalidados por último.
      .order("valido", { ascending: false })
      .order("principal", { ascending: false })
      .order("criado_em", { ascending: true });
    if (!error) setContatos(data || []);
    setCarregando(false);
  }, [aluno?.id]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    setResp({
      nome_resp1: aluno?.nome_resp1 || "",
      telefone_resp1: aluno?.telefone_resp1 || "",
      nome_resp2: aluno?.nome_resp2 || "",
      telefone_resp2: aluno?.telefone_resp2 || "",
    });
  }, [aluno?.id]);

  async function adicionar(tipo, valor) {
    if (!aluno?.id || !String(valor || "").trim()) return;
    setMsg("");
    const { data, error } = await supabase.rpc("aluno_contato_adicionar", {
      p_aluno_id: aluno.id, p_tipo: tipo, p_valor: valor, p_origem: "operador",
    });
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) {
      setMsg(data?.motivo === "TELEFONE_INVALIDO" ? "Número inválido." : "Valor inválido.");
      return;
    }
    // `novo: false` = o contato já estava lá. Vale avisar, senão o operador
    // acha que não salvou.
    setMsg(data.novo ? "Adicionado." : "Esse contato já estava cadastrado.");
    if (tipo === "telefone") setNovoTel(""); else setNovoMail("");
    carregar();
  }

  async function invalidar(c) {
    const motivo = window.prompt(
      `Invalidar ${c.tipo === "telefone" ? exibirTelefone(c.valor) : c.valor}?\n\nPor quê? (ex.: não é a pessoa, número não existe)`,
      "",
    );
    if (motivo === null) return;
    const { error } = await supabase.rpc("aluno_contato_invalidar", { p_id: c.id, p_motivo: motivo });
    setMsg(error ? "Erro: " + error.message : "Contato invalidado.");
    carregar();
  }

  async function revalidar(c) {
    const { error } = await supabase.rpc("aluno_contato_revalidar", { p_id: c.id });
    setMsg(error ? "Erro: " + error.message : "Contato reativado.");
    carregar();
  }

  async function tornarPrincipal(c) {
    const { error } = await supabase.rpc("aluno_contato_tornar_principal", { p_id: c.id });
    setMsg(error ? "Erro: " + error.message : "Principal atualizado.");
    carregar();
  }

  async function salvarResp() {
    if (!aluno?.id) return;
    setSalvandoResp(true);
    try {
      const { error } = await supabase.from("alunos").update({
        nome_resp1: resp.nome_resp1.trim() || null,
        telefone_resp1: resp.telefone_resp1.trim() || null,
        nome_resp2: resp.nome_resp2.trim() || null,
        telefone_resp2: resp.telefone_resp2.trim() || null,
      }).eq("id", aluno.id);
      setMsg(error ? "Erro ao salvar: " + error.message : "Responsáveis salvos.");
    } finally { setSalvandoResp(false); }
  }

  function zap(tel) {
    const d = soDigitos(tel);
    if (!d) { setMsg("Número vazio ou inválido."); return; }
    window.open("https://wa.me/" + d, "_blank");
  }

  const telefones = contatos.filter((c) => c.tipo === "telefone");
  const emails = contatos.filter((c) => c.tipo === "email");

  function Contato({ c }) {
    const texto = c.tipo === "telefone" ? exibirTelefone(c.valor) : c.valor;
    return (
      <div style={{ ...S.item, ...(c.valido ? null : S.itemInvalido) }}>
        <span style={{ ...S.valor, ...(c.valido ? null : S.valorInvalido) }}>{texto}</span>
        {c.principal && c.valido ? <span style={S.tagPrincipal}>principal</span> : null}
        <span style={S.tagOrigem}>{ROTULO_ORIGEM[c.origem] || c.origem}</span>
        {c.valido ? (
          <>
            {c.tipo === "telefone" ? (
              <button style={S.zap} onClick={() => zap(c.valor)} title="Abrir WhatsApp">WhatsApp</button>
            ) : null}
            {!c.principal ? (
              <button style={S.botaoLeve} onClick={() => tornarPrincipal(c)}>Tornar principal</button>
            ) : null}
            <button style={S.botaoInvalidar} onClick={() => invalidar(c)}>Invalidar</button>
          </>
        ) : (
          <>
            <span style={S.motivo} title={c.invalidado_por_email || ""}>
              inválido{c.motivo_invalidacao ? ` — ${c.motivo_invalidacao}` : ""}
            </span>
            <button style={S.botaoLeve} onClick={() => revalidar(c)}>Reativar</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.head}>Contatos do aluno</div>

      {carregando && contatos.length === 0 ? <div style={S.vazio}>Carregando…</div> : null}

      <div style={S.grupo}>
        <span style={S.rot}>Telefones</span>
        <div style={S.lista}>
          {telefones.length === 0 && !carregando ? <div style={S.vazio}>Nenhum telefone cadastrado.</div> : null}
          {telefones.map((c) => <Contato key={c.id} c={c} />)}
          <div style={S.linhaNovo}>
            <input
              style={S.inTel}
              placeholder="(DDD) número"
              value={novoTel}
              onChange={(e) => setNovoTel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") adicionar("telefone", novoTel); }}
            />
            <button style={S.botaoAdd} onClick={() => adicionar("telefone", novoTel)}>Adicionar telefone</button>
          </div>
        </div>
      </div>

      <div style={S.grupo}>
        <span style={S.rot}>E-mails</span>
        <div style={S.lista}>
          {emails.length === 0 && !carregando ? <div style={S.vazio}>Nenhum e-mail cadastrado.</div> : null}
          {emails.map((c) => <Contato key={c.id} c={c} />)}
          <div style={S.linhaNovo}>
            <input
              style={S.inMail}
              placeholder="email@exemplo.com"
              value={novoMail}
              onChange={(e) => setNovoMail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") adicionar("email", novoMail); }}
            />
            <button style={S.botaoAdd} onClick={() => adicionar("email", novoMail)}>Adicionar e-mail</button>
          </div>
        </div>
      </div>

      <div style={S.grupo}>
        <span style={S.rot}>Responsáveis</span>
        <div style={S.lista}>
          {[1, 2].map((n) => (
            <div key={n} style={S.linhaNovo}>
              <input
                style={S.inNome}
                placeholder={`Nome do responsável ${n}`}
                value={resp[`nome_resp${n}`]}
                onChange={(e) => setResp((v) => ({ ...v, [`nome_resp${n}`]: e.target.value }))}
              />
              <input
                style={S.inTel}
                placeholder="(DDD) número"
                value={resp[`telefone_resp${n}`]}
                onChange={(e) => setResp((v) => ({ ...v, [`telefone_resp${n}`]: e.target.value }))}
              />
              <button style={S.zap} onClick={() => zap(resp[`telefone_resp${n}`])} title="Abrir WhatsApp">WhatsApp</button>
            </div>
          ))}
          <div style={S.acoes}>
            <button style={S.salvar} onClick={salvarResp} disabled={salvandoResp}>
              {salvandoResp ? "Salvando…" : "Salvar responsáveis"}
            </button>
          </div>
        </div>
      </div>

      {msg ? <div style={S.msg}>{msg}</div> : null}
    </div>
  );
}

const S = {
  wrap: { border: "1px solid #eef2f6", borderRadius: 12, padding: 14, marginTop: 12, background: "#fff" },
  head: { fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 10 },
  grupo: { display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  rot: { fontSize: 12, color: "#64748b", fontWeight: 700, minWidth: 96, paddingTop: 7 },
  lista: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 260 },
  item: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  itemInvalido: { opacity: 0.75 },
  valor: { fontSize: 13, fontWeight: 600, color: "#0f172a", minWidth: 140 },
  valorInvalido: { textDecoration: "line-through", color: "#64748b", fontWeight: 500 },
  tagPrincipal: { fontSize: 11, fontWeight: 700, color: "#1d4ed8", background: "#e8eef6", borderRadius: 999, padding: "2px 8px" },
  tagOrigem: { fontSize: 11, color: "#64748b", background: "#f1f5f9", borderRadius: 999, padding: "2px 8px" },
  motivo: { fontSize: 12, color: "#b45309" },
  linhaNovo: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
  inNome: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 13, minWidth: 150 },
  inTel: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 13, minWidth: 140 },
  inMail: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 13, minWidth: 200 },
  zap: { background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  botaoAdd: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "7px 12px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  botaoLeve: { background: "#fff", color: "#334155", border: "1px solid #cbd5e1", borderRadius: 8, padding: "5px 10px", fontWeight: 600, cursor: "pointer", fontSize: 12 },
  botaoInvalidar: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "5px 10px", fontWeight: 600, cursor: "pointer", fontSize: 12 },
  acoes: { display: "flex", alignItems: "center", gap: 12, marginTop: 2 },
  salvar: { background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 8, padding: "9px 14px", fontWeight: 700, cursor: "pointer" },
  vazio: { fontSize: 12, color: "#94a3b8" },
  msg: { fontSize: 12, color: "#166534", fontWeight: 600, marginTop: 4 },
};
