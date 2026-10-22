import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../services/supabase";

// FILA DE REVISÃO CADASTRAL — contatos compartilhados entre pessoas diferentes.
//
// POR QUE EXISTE: a ação massiva deixou de enviar para telefone ou e-mail que
// aparece em fichas de CPFs diferentes, porque o dado não diz qual das pessoas
// é a dona do contato — e mandar cobrança para a pessoa errada conta a dívida
// de um terceiro. Em outubro/2026, 32 números receberam mensagem sobre 107
// pessoas diferentes por esse caminho; um deles recebeu 21 mensagens sobre 18
// pessoas.
//
// O bloqueio só sai quando alguém confirma de quem é o contato. Esta tela é
// esse caminho: lista os contatos em conflito e leva à ficha de cada aluno,
// onde o contato errado é invalidado (qualquer operador, com motivo) e onde a
// reativação é exclusiva do Administrativo e da supervisão.
//
// A fila vem de `contato_fila_revisao`, que tem o portão de permissão dentro da
// própria função — esta tela não decide acesso, só apresenta.

const CANAIS = [
  { v: "", label: "Todos" },
  { v: "TELEFONE", label: "Telefone" },
  { v: "EMAIL", label: "E-mail" },
];

function mascarar(canal, contato) {
  // A fila é de quem pode ver contato, mas não há razão para repetir o valor
  // inteiro na lista: mostra o suficiente para reconhecer, e a ficha tem o
  // valor completo.
  const v = String(contato || "");
  if (canal === "EMAIL") {
    const [antes, dominio] = v.split("@");
    if (!dominio) return v;
    const cabeca = antes.slice(0, 2);
    return `${cabeca}${"•".repeat(Math.max(antes.length - 2, 1))}@${dominio}`;
  }
  if (v.length <= 4) return v;
  return `${v.slice(0, 2)}${"•".repeat(v.length - 6)}${v.slice(-4)}`;
}

export default function RevisaoCadastral() {
  const [canal, setCanal] = useState("");
  const [fila, setFila] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("contato_fila_revisao", {
      p_canal: canal || null,
      p_limite: 500,
    });
    if (error) {
      // 42501 vem do portão da própria função: Administrativo e supervisão.
      setErro(
        /negado/i.test(error.message)
          ? "Esta fila é do Administrativo e da supervisão."
          : "Erro ao carregar: " + error.message,
      );
      setFila([]);
    } else {
      setFila(data || []);
    }
    setCarregando(false);
  }, [canal]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const prioritarios = fila.filter((f) => f.revisao_prioritaria).length;
  const pessoas = fila.reduce((s, f) => s + Number(f.pessoas || 0), 0);
  const semAlternativo = fila.reduce(
    (s, f) => s + (f.alunos || []).filter((a) => !a.tem_canal_alternativo).length,
    0,
  );
  // Quantas fichas começam por conferir um contato que já está cadastrado, em
  // vez de conferir titularidade do zero. É a separação que a gestão pediu.
  const aConferir = fila.reduce(
    (s, f) => s + (f.alunos || []).filter((a) => a.alternativa_potencial).length,
    0,
  );

  return (
    <div style={S.pagina}>
      <h1 style={S.titulo}>Revisão cadastral de contatos</h1>
      <p style={S.sub}>
        Contatos que aparecem em fichas de <strong>pessoas diferentes</strong>. Enquanto o
        conflito existir, a ação massiva não usa esse canal para nenhuma das fichas — não há
        como saber de quem é o contato. Abra a ficha, confirme a titularidade e invalide o
        contato que não pertence àquela pessoa.{" "}
        <strong>Alternativa a conferir</strong> significa que a ficha tem outro contato já
        cadastrado — ainda assim é preciso confirmar com o aluno de quem ele é: não haver
        colisão não comprova titularidade.
      </p>

      <div style={S.barra}>
        <div style={S.filtro}>
          {CANAIS.map((c) => (
            <button
              key={c.v}
              onClick={() => setCanal(c.v)}
              style={{ ...S.aba, ...(canal === c.v ? S.abaAtiva : null) }}
              data-testid={`aba-${c.v || "todos"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button style={S.botaoLeve} onClick={carregar} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      {erro ? <div style={S.erro} data-testid="erro">{erro}</div> : null}

      {!erro && !carregando ? (
        <div style={S.resumo} data-testid="resumo">
          <span><strong>{fila.length}</strong> contatos em conflito</span>
          <span><strong>{pessoas}</strong> fichas envolvidas</span>
          <span><strong>{prioritarios}</strong> prioritários (5 ou mais pessoas)</span>
          <span><strong>{semAlternativo}</strong> fichas sem canal alternativo</span>
          <span><strong>{aConferir}</strong> com alternativa a conferir</span>
        </div>
      ) : null}

      {!erro && !carregando && fila.length === 0 ? (
        <div style={S.vazio} data-testid="vazio">
          Nenhum contato em conflito. Nada a revisar.
        </div>
      ) : null}

      <div style={S.lista}>
        {fila.map((f) => (
          <div
            key={`${f.canal}:${f.contato}`}
            style={{ ...S.card, ...(f.revisao_prioritaria ? S.cardPrioritario : null) }}
            data-testid="linha-fila"
          >
            <div style={S.cardTopo}>
              <span style={S.tagCanal}>{f.canal === "EMAIL" ? "E-mail" : "Telefone"}</span>
              <span style={S.contato}>{mascarar(f.canal, f.contato)}</span>
              <span style={S.tagPessoas}>{f.pessoas} pessoas</span>
              {f.revisao_prioritaria ? (
                <span style={S.tagPrioritario} data-testid="tag-prioritario">prioritário</span>
              ) : null}
            </div>
            <div style={S.alunos}>
              {(f.alunos || []).map((a) => (
                <Link key={a.aluno_id} to={`/aluno?id=${a.aluno_id}`} style={S.aluno}>
                  {a.nome || a.aluno_id}
                  {a.alternativa_potencial ? (
                    <span
                      style={S.aConferir}
                      data-testid="marca-alternativa"
                      title="Há outro contato cadastrado nesta ficha que talvez sirva. Confirme com o aluno de quem é o contato antes de promover — a ausência de colisão não comprova titularidade."
                    >
                      Alternativa a conferir
                    </span>
                  ) : null}
                  {a.tem_canal_alternativo ? null : (
                    <span style={S.semCanal} title="Bloquear este canal deixa a ficha sem nenhum canal">
                      sem outro canal
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const S = {
  pagina: { padding: "18px 20px 40px", maxWidth: 1000 },
  titulo: { margin: "0 0 6px", fontSize: 22, color: "var(--rv-texto)" },
  sub: { margin: "0 0 16px", fontSize: 14, lineHeight: 1.5, color: "var(--rv-texto-suave)" },
  barra: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  filtro: { display: "flex", gap: 6 },
  aba: {
    padding: "6px 12px", borderRadius: 8, border: "1px solid var(--rv-borda)",
    background: "transparent", color: "var(--rv-texto-suave)", cursor: "pointer", fontSize: 13,
  },
  abaAtiva: { background: "var(--rv-azul-fundo)", color: "var(--rv-azul-texto)", fontWeight: 600 },
  botaoLeve: {
    padding: "6px 12px", borderRadius: 8, border: "1px solid var(--rv-borda)",
    background: "transparent", color: "var(--rv-texto-suave)", cursor: "pointer", fontSize: 13,
  },
  resumo: {
    display: "flex", flexWrap: "wrap", gap: 18, padding: "10px 14px", marginBottom: 14,
    borderRadius: 10, background: "var(--rv-fundo-suave)", fontSize: 13, color: "var(--rv-texto-suave)",
  },
  erro: {
    padding: "10px 14px", marginBottom: 14, borderRadius: 10,
    background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", fontSize: 14,
  },
  vazio: { padding: "18px 14px", fontSize: 14, color: "var(--rv-texto-suave)" },
  lista: { display: "flex", flexDirection: "column", gap: 10 },
  card: {
    border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 14px",
    background: "var(--rv-fundo-cartao)",
  },
  cardPrioritario: { borderColor: "var(--rv-ambar-texto)" },
  cardTopo: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  tagCanal: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--rv-texto-suave)" },
  contato: { fontFamily: "ui-monospace, monospace", fontSize: 14, color: "var(--rv-texto)" },
  tagPessoas: { fontSize: 12, color: "var(--rv-texto-suave)" },
  tagPrioritario: {
    fontSize: 11, padding: "2px 8px", borderRadius: 999,
    background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", fontWeight: 600,
  },
  alunos: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 },
  aluno: {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
    padding: "4px 10px", borderRadius: 999, border: "1px solid var(--rv-borda)",
    color: "var(--rv-azul-texto)", textDecoration: "none",
  },
  semCanal: { fontSize: 11, color: "var(--rv-ambar-texto)" },
  aConferir: {
    fontSize: 11, padding: "1px 6px", borderRadius: 999,
    background: "var(--rv-azul-fundo)", color: "var(--rv-azul-texto)", fontWeight: 600,
  },
};
