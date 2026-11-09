import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import Dobra from "../ui/blocos";

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

// `children` = acoes que PERTENCEM aos contatos mas moram em outro componente.
// Hoje e o botao da Mensageria ULBRA, que vive no `BlocoUlbra`. Este bloco so
// da LUGAR a ele, dentro do cartao: a condicao de exibicao (vinculo confirmado
// por CPF) e a abertura em nova aba continuam inteiras la dentro, onde o portao
// de identidade foi escrito. Nada aqui decide se o botao aparece.
//
// O lugar mudou em 08/11/2026, por decisao da gestao: era o RODAPE do cartao e
// so aparecia depois de rolar; agora e o CABECALHO, na mesma linha do titulo.
export default function TelefonesAluno({ aluno, children }) {
  // A7: reativar contato e exclusivo do Administrativo e da supervisao. O
  // portao de verdade esta dentro de `aluno_contato_revalidar`; aqui o botao e
  // escondido para nao oferecer uma acao que vai ser recusada.
  const [podeReativar, setPodeReativar] = useState(false);
  const [contatos, setContatos] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [novoTel, setNovoTel] = useState("");
  const [novoMail, setNovoMail] = useState("");
  const [msg, setMsg] = useState("");
  // Qual valor acabou de ser copiado -- so para o retorno visual do botao.
  const [copiado, setCopiado] = useState("");

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

  useEffect(() => {
    let vivo = true;
    supabase.rpc("usuario_pode_revalidar_contato").then(({ data }) => {
      if (vivo) setPodeReativar(data === true);
    });
    return () => { vivo = false; };
  }, []);

  async function invalidar(c) {
    const motivo = window.prompt(
      `Invalidar ${c.tipo === "telefone" ? exibirTelefone(c.valor) : c.valor}?\n\nPor quê? (ex.: não é a pessoa, número não existe)`,
      "",
    );
    if (motivo === null) return;
    if (!String(motivo).trim()) {
      setMsg("Motivo obrigatório para invalidar.");
      return;
    }
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

  // Copiar o numero/e-mail cru -- e o que o operador cola no Prime e no
  // discador. O fallback do textarea existe porque a clipboard API exige
  // contexto seguro e nem todo navegador da operacao esta nele.
  async function copiar(valor) {
    const texto = String(valor || "").trim();
    if (!texto) { setMsg("Nada para copiar."); return; }
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = texto;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopiado(texto);
    setTimeout(() => setCopiado((v) => (v === texto ? "" : v)), 1500);
  }

  function zap(tel) {
    const d = soDigitos(tel);
    if (!d) { setMsg("Número vazio ou inválido."); return; }
    window.open("https://wa.me/" + d, "_blank");
  }

  const telefones = contatos.filter((c) => c.tipo === "telefone");
  const emails = contatos.filter((c) => c.tipo === "email");
  // Qual telefone recebe o destaque. Precisa ser `principal` E `valido`: um
  // principal invalidado nao pode ser oferecido como o numero a discar. Se o
  // banco nao marcou nenhum, ninguem ganha destaque -- a ficha nao inventa.
  const idPrincipal = telefones.find((c) => c.principal && c.valido)?.id || null;
  // O numero no titulo da dobra existe para nada ficar escondido sem aviso:
  // fechado com "(2)" o operador sabe que ha responsavel cadastrado.
  const qtdResp = [resp.telefone_resp1, resp.telefone_resp2].filter((t) => String(t || "").trim()).length;

  // `destaque` = este e o contato principal e valido. Ele ganha moldura e
  // fonte maior porque e o numero que o operador disca primeiro; os demais
  // continuam TODOS visiveis, so com peso menor -- nada entra atras de clique.
  function Contato({ c, destaque }) {
    const texto = c.tipo === "telefone" ? exibirTelefone(c.valor) : c.valor;
    const estaCopiado = copiado === String(c.valor || "").trim();
    return (
      <div
        style={{
          ...S.item,
          ...(destaque ? S.itemDestaque : null),
          ...(c.valido ? null : S.itemInvalido),
        }}
      >
        <span
          style={{
            ...S.valor,
            ...(destaque ? S.valorDestaque : null),
            ...(c.valido ? null : S.valorInvalido),
          }}
        >
          {texto}
        </span>
        {c.principal && c.valido ? (
          <span style={destaque ? S.tagPrincipalForte : S.tagPrincipal}>principal</span>
        ) : null}
        <span style={S.tagOrigem}>{ROTULO_ORIGEM[c.origem] || c.origem}</span>
        {c.valido ? (
          <>
            {/* Acoes de atendimento: WhatsApp e copiar ficam sempre a um
                clique, com peso visual proprio. */}
            {c.tipo === "telefone" ? (
              <button style={destaque ? S.zapForte : S.zap} onClick={() => zap(c.valor)} title="Abrir WhatsApp">WhatsApp</button>
            ) : null}
            <button
              style={estaCopiado ? S.copiarOk : S.copiar}
              onClick={() => copiar(c.valor)}
              title={c.tipo === "telefone" ? "Copiar o número" : "Copiar o e-mail"}
            >
              {estaCopiado ? "✓ Copiado" : "Copiar"}
            </button>
            {/* Acoes administrativas: recuam para texto discreto. O que elas
                fazem e quem pode fazer NAO mudou -- so o peso visual. */}
            {!c.principal ? (
              <button style={S.botaoAdmin} onClick={() => tornarPrincipal(c)}>Tornar principal</button>
            ) : null}
            <button style={S.botaoAdminRisco} onClick={() => invalidar(c)}>Invalidar</button>
          </>
        ) : (
          <>
            <span style={S.motivo} title={c.invalidado_por_email || ""}>
              inválido{c.motivo_invalidacao ? ` — ${c.motivo_invalidacao}` : ""}
            </span>
            {podeReativar ? (
              <button style={S.botaoAdmin} onClick={() => revalidar(c)}>Reativar</button>
            ) : (
              <span style={S.semPermissao} title="Reativar contato é do Administrativo e da supervisão">
                reativação: Administrativo
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      {/* Titulo e acao do canal na MESMA linha, no topo do cartao: o botao da
          Mensageria tem de ser visto sem rolagem. `flexWrap` cuida da tela
          estreita -- quando os dois nao cabem, o botao desce para a propria
          linha, ainda ACIMA da lista de telefones, sem sobrepor numero nenhum.
          Sem `children` a linha fica so com o titulo, sem faixa vazia. */}
      <div style={S.cabecalho}>
        <div style={S.head}>Contatos do aluno</div>
        {children ? <div style={S.acaoCanal}>{children}</div> : null}
      </div>

      {carregando && contatos.length === 0 ? <div style={S.vazio}>Carregando…</div> : null}

      <div style={S.grupoAberto}>
        <div style={S.lista}>
          {telefones.length === 0 && !carregando ? <div style={S.vazio}>Nenhum telefone cadastrado.</div> : null}
          {telefones.map((c) => (
            <Contato key={c.id} c={c} destaque={c.id === idPrincipal} />
          ))}
          <div style={S.linhaNovo}>
            <input
              style={S.inTel}
              placeholder="(DDD) número"
              value={novoTel}
              onChange={(e) => setNovoTel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") adicionar("telefone", novoTel); }}
            />
            <button style={S.botaoAddLeve} onClick={() => adicionar("telefone", novoTel)}>Adicionar telefone</button>
          </div>
        </div>
      </div>

      <Dobra titulo="E-mails" contador={emails.length || null} tema="embutido" style={S.grupoDobra}>
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
      </Dobra>

      <Dobra titulo="Responsáveis" contador={qtdResp || null} tema="embutido" style={S.grupoDobra}>
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
              <button
                style={copiado === String(resp[`telefone_resp${n}`] || "").trim() && String(resp[`telefone_resp${n}`] || "").trim() ? S.copiarOk : S.copiar}
                onClick={() => copiar(resp[`telefone_resp${n}`])}
                title="Copiar o número"
              >
                Copiar
              </button>
            </div>
          ))}
          <div style={S.acoes}>
            <button style={S.salvarLeve} onClick={salvarResp} disabled={salvandoResp}>
              {salvandoResp ? "Salvando…" : "Salvar responsáveis"}
            </button>
          </div>
        </div>
      </Dobra>

      {msg ? <div style={S.msg}>{msg}</div> : null}
    </div>
  );
}

const CAMPO = {
  background: "var(--rv-fundo-cartao)",
  color: "var(--rv-texto-forte)",
  border: "1px solid var(--rv-borda-forte)",
  borderRadius: 8,
  padding: "7px 9px",
  fontSize: 13,
};

const S = {
  wrap: { border: "1px solid var(--rv-borda-suave)", borderRadius: 12, padding: "10px 12px", marginTop: 10, background: "var(--rv-superficie)" },
  cabecalho: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 },
  head: { fontSize: 13, fontWeight: 700, color: "var(--rv-tinta)" },
  acaoCanal: { minWidth: 0, maxWidth: "100%" },
  grupoAberto: { display: "flex", gap: 10, marginBottom: 8, flexWrap: "wrap" },
  grupoDobra: { marginBottom: 2 },
  rot: { fontSize: 12, color: "var(--rv-texto-suave)", fontWeight: 700, minWidth: 96, paddingTop: 7 },
  lista: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 260, marginTop: 6 },
  item: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  // Moldura do principal: borda esquerda azul, como o bloco de decisao do
  // cabecalho usa. E o unico contato com fundo proprio.
  itemDestaque: {
    gap: 8,
    background: "var(--rv-fundo-suave)",
    border: "1px solid var(--rv-azul-borda)",
    borderLeft: "4px solid #2563eb",
    borderRadius: 10,
    padding: "7px 10px",
  },
  itemInvalido: { opacity: 0.75 },
  valor: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)", minWidth: 140 },
  valorDestaque: { fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" },
  valorInvalido: { textDecoration: "line-through", color: "var(--rv-texto-suave)", fontWeight: 500 },
  tagPrincipal: { fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)", background: "var(--rv-fundo-suave)", borderRadius: 999, padding: "2px 8px" },
  tagPrincipalForte: { fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: "#fff", background: "#2563eb", borderRadius: 999, padding: "2px 9px" },
  tagOrigem: { fontSize: 11, color: "var(--rv-texto-suave)", background: "var(--rv-fundo-suave)", borderRadius: 999, padding: "2px 8px" },
  motivo: { fontSize: 12, color: "var(--rv-ambar-texto)" },
  semPermissao: { fontSize: 11, color: "var(--rv-texto-suave)", fontStyle: "italic" },
  linhaNovo: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
  // O `index.css` tem uma regra global `input { background: #0f172a }`, do
  // tema escuro. Estes campos nao declaravam fundo nem cor, entao herdavam o
  // escuro e saiam como caixas pretas dentro de um cartao claro. Fundo, texto
  // e borda passam a ser explicitos, nos mesmos tokens dos outros campos da
  // ficha -- so neste componente, sem mexer na regra global, que vale para
  // todas as telas do CRM.
  inNome: { ...CAMPO, minWidth: 150 },
  inTel: { ...CAMPO, minWidth: 140 },
  inMail: { ...CAMPO, minWidth: 200 },
  zap: { background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "5px 10px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  zapForte: { background: "#25D366", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 800, cursor: "pointer", fontSize: 13 },
  copiar: { background: "var(--rv-superficie)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "5px 10px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  copiarOk: { background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", border: "1px solid var(--rv-verde-ok-borda)", borderRadius: 8, padding: "5px 10px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  // Acoes administrativas: sem moldura, cor suave, fonte menor. Continuam
  // clicaveis e com a mesma regra de permissao -- so nao competem com o
  // WhatsApp e o copiar.
  botaoAdmin: { background: "transparent", color: "var(--rv-texto-suave)", border: "none", padding: "4px 4px", fontWeight: 600, cursor: "pointer", fontSize: 11.5, textDecoration: "underline" },
  botaoAdminRisco: { background: "transparent", color: "var(--rv-vermelho-texto)", border: "none", padding: "4px 4px", fontWeight: 600, cursor: "pointer", fontSize: 11.5, textDecoration: "underline", opacity: 0.85 },
  botaoAddLeve: { background: "var(--rv-superficie)", color: "var(--rv-azul-texto)", border: "1px solid var(--rv-azul-borda)", borderRadius: 8, padding: "6px 11px", fontWeight: 700, cursor: "pointer", fontSize: 12 },
  acoes: { display: "flex", alignItems: "center", gap: 12, marginTop: 2 },
  salvarLeve: { background: "var(--rv-superficie)", color: "var(--rv-azul-texto)", border: "1px solid var(--rv-azul-borda)", borderRadius: 8, padding: "6px 11px", fontWeight: 700, fontSize: 12, cursor: "pointer" },
  vazio: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  msg: { fontSize: 12, color: "var(--rv-verde-ok-texto)", fontWeight: 600, marginTop: 4 },
};
