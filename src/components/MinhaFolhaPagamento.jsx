import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(valor) {
  if (valor === null || valor === undefined) return "-";
  return Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABEL = {
  RASCUNHO: "Em preparação",
  ENVIADO_FINANCEIRO: "Aguardando você emitir a nota",
  AGUARDANDO_NOTA: "Aguardando você emitir a nota",
  NOTA_ANEXADA: "Nota enviada — aguardando pagamento",
  PAGO: "Pago",
};

function corStatus(status) {
  if (status === "PAGO") return { bg: "rgba(34,197,94,0.16)", texto: "#93c5fd" };
  if (status === "NOTA_ANEXADA") return { bg: "rgba(56,189,248,0.16)", texto: "#7dd3fc" };
  if (status === "ENVIADO_FINANCEIRO" || status === "AGUARDANDO_NOTA")
    return { bg: "rgba(251,191,36,0.16)", texto: "#fcd34d" };
  return { bg: "rgba(148,163,184,0.16)", texto: "#cbd5e1" };
}

// Mostra pro operador logado só os PRÓPRIOS fechamentos mensais (o RLS já
// garante isso no banco), com o valor a faturar e onde anexar a nota
// fiscal do mês. Não aparece nada se ele não tiver nenhum fechamento
// ainda (RASCUNHO ainda em preparação pela Amanda não conta como
// "pronto pra ver", então só mostramos ENVIADO_FINANCEIRO em diante).
export default function MinhaFolhaPagamento({ email }) {
  const [fechamentos, setFechamentos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [enviandoId, setEnviandoId] = useState(null);
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (!email) {
      setCarregando(false);
      return;
    }
    carregar();
  }, [email]);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("rh_fechamentos_mensais")
      .select("*")
      .order("mes_referencia", { ascending: false });

    if (error) {
      console.error("Erro ao carregar fechamentos:", error);
      setCarregando(false);
      return;
    }

    setFechamentos((data || []).filter((f) => f.status !== "RASCUNHO"));
    setCarregando(false);
  }

  async function anexarNota(fechamento, arquivo) {
    if (!arquivo) return;

    setErro("");
    setEnviandoId(fechamento.id);

    try {
      const nomeSeguro = arquivo.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const caminho = `${email}/${fechamento.mes_referencia}-${Date.now()}-${nomeSeguro}`;

      const { error: erroUpload } = await supabase.storage
        .from("notas-fiscais-operadores")
        .upload(caminho, arquivo);

      if (erroUpload) throw erroUpload;

      const { data: assinada } = await supabase.storage
        .from("notas-fiscais-operadores")
        .createSignedUrl(caminho, 60 * 60 * 24 * 365 * 5);

      const { error: erroRpc } = await supabase.rpc("anexar_nota_fiscal_operador", {
        p_fechamento_id: fechamento.id,
        p_nota_url: assinada?.signedUrl || caminho,
        p_nota_nome: arquivo.name,
      });

      if (erroRpc) throw erroRpc;

      await carregar();
    } catch (e) {
      console.error("Erro ao anexar nota fiscal:", e);
      setErro("Erro ao anexar nota fiscal: " + (e.message || "tente novamente."));
    } finally {
      setEnviandoId(null);
    }
  }

  if (carregando || fechamentos.length === 0) return null;

  return (
    <div style={estilos.caixa}>
      <strong>🧾 Minha folha / nota fiscal</strong>

      {erro && <p style={estilos.erro}>{erro}</p>}

      <div style={{ marginTop: 10 }}>
        {fechamentos.map((f) => {
          const cores = corStatus(f.status);
          const precisaNota = f.status === "ENVIADO_FINANCEIRO" || f.status === "AGUARDANDO_NOTA";

          return (
            <div key={f.id} style={estilos.linha}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{f.mes_referencia}</div>
                <div style={estilos.sub}>
                  Comissão {moeda(f.valor_comissao)} + Salário {moeda(f.valor_salario)}
                </div>
                <div style={{ ...estilos.sub, fontWeight: 700 }}>
                  Valor a faturar: {moeda(f.valor_total)}
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <span style={{ ...estilos.badge, background: cores.bg, color: cores.texto }}>
                  {STATUS_LABEL[f.status] || f.status}
                </span>

                {precisaNota && (
                  <label style={estilos.botaoUpload}>
                    {enviandoId === f.id ? "Enviando..." : "Anexar nota fiscal"}
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      style={{ display: "none" }}
                      disabled={enviandoId === f.id}
                      onChange={(e) => anexarNota(f, e.target.files?.[0])}
                    />
                  </label>
                )}

                {f.nota_fiscal_url && (
                  <a href={f.nota_fiscal_url} target="_blank" rel="noreferrer" style={estilos.link}>
                    Ver nota enviada
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginTop: 14,
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(168,85,247,0.06)",
    border: "1px solid rgba(168,85,247,0.25)",
  },
  erro: {
    color: "#fca5a5",
    fontSize: 12,
    marginTop: 6,
  },
  linha: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "10px 0",
    borderTop: "1px solid rgba(148,163,184,0.12)",
    gap: 12,
  },
  sub: {
    fontSize: 11,
    opacity: 0.8,
    marginTop: 2,
  },
  badge: {
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 9px",
    borderRadius: 999,
    display: "inline-block",
  },
  botaoUpload: {
    display: "block",
    marginTop: 8,
    fontSize: 12,
    fontWeight: 700,
    color: "#c4b5fd",
    cursor: "pointer",
    textDecoration: "underline",
  },
  link: {
    display: "block",
    marginTop: 8,
    fontSize: 12,
    color: "#93c5fd",
  },
};
