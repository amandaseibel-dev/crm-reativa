import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { OPCOES_LOGOTIPO, NOME_MARCA, mensagemErroVotacao, percentuais } from "./votacaoLogotipo";

// Votação interna do novo logotipo. Toda regra fica no banco (RPCs
// portal_logotipo_*); esta tela só mostra e chama.
//
// Regras de exibição:
//   * Operador: vê as quatro propostas e pode votar uma vez. Não vê contagem
//     enquanto a votação está aberta.
//   * Gestão: acompanha a contagem a qualquer momento e encerra a votação.
//   * Depois do encerramento, o resultado fica visível a todos.

const card = {
  background: "var(--rv-superficie)",
  border: "1px solid var(--rv-borda)",
  borderRadius: "var(--rv-raio)",
  padding: "clamp(16px, 3vw, 24px)",
};

const botao = (primario) => ({
  padding: "10px 16px",
  borderRadius: "var(--rv-raio-pequeno)",
  border: primario ? "none" : "1px solid var(--rv-azul)",
  background: primario ? "var(--rv-azul)" : "transparent",
  color: primario ? "#fff" : "var(--rv-azul-texto)",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  minHeight: 44,
});

function Quadro({ numero, imagem, titulo, selecionada, bloqueada, onVotar, ocupado }) {
  return (
    <article
      aria-label={`${titulo}: ${NOME_MARCA}`}
      style={{
        ...card,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        borderColor: selecionada ? "var(--rv-azul)" : "var(--rv-borda)",
        boxShadow: selecionada ? "0 0 0 2px var(--rv-azul-borda)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            width: 32, height: 32, borderRadius: "50%", background: "var(--rv-azul)",
            color: "#fff", fontWeight: 700, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
          }}
        >
          {numero}
        </span>
        {selecionada && (
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--rv-azul-texto)" }}>✓ Seu voto</span>
        )}
      </div>

      <div
        style={{
          aspectRatio: "16 / 10", borderRadius: "var(--rv-raio-pequeno)",
          background: "var(--rv-azul-fundo)", border: "1px dashed var(--rv-azul-borda)",
          display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
        }}
      >
        {imagem ? (
          <img src={imagem} alt={`${titulo}: ${NOME_MARCA}`} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : (
          <div style={{ textAlign: "center", padding: 12, color: "var(--rv-azul-texto)" }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{NOME_MARCA}</div>
            <div style={{ fontSize: 12, marginTop: 6, color: "var(--rv-texto-suave)" }}>Arte final em validação</div>
          </div>
        )}
      </div>

      <div style={{ fontWeight: 600 }}>{titulo}</div>

      <button
        type="button"
        onClick={() => onVotar(numero)}
        disabled={bloqueada || ocupado}
        style={{ ...botao(!bloqueada), opacity: bloqueada ? 0.55 : 1, cursor: bloqueada ? "default" : "pointer" }}
      >
        {selecionada ? "Voto registrado" : `Votar na ${titulo}`}
      </button>
    </article>
  );
}

function Apuracao({ apuracao }) {
  const linhas = percentuais(apuracao.opcoes, apuracao.total);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 14, color: "var(--rv-texto-suave)" }}>
        {apuracao.total} voto{apuracao.total === 1 ? "" : "s"} registrado{apuracao.total === 1 ? "" : "s"}
      </div>
      {linhas.map((l) => (
        <div key={l.opcao} style={{ display: "grid", gridTemplateColumns: "120px 1fr 90px", gap: 10, alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Proposta {l.opcao}</span>
          <div role="progressbar" aria-valuenow={l.percentual} aria-valuemin={0} aria-valuemax={100}
               style={{ height: 12, borderRadius: 6, background: "var(--rv-fundo-suave)", overflow: "hidden" }}>
            <div style={{ width: `${l.percentual}%`, height: "100%", background: "var(--rv-azul)" }} />
          </div>
          <span style={{ fontSize: 13, textAlign: "right" }}>{l.votos} ({l.percentual}%)</span>
        </div>
      ))}
    </div>
  );
}

// Lê a situação e, se a pessoa pode ver, a contagem. Não toca em estado da tela.
async function lerVotacao() {
  const { data, error } = await supabase.rpc("portal_logotipo_situacao");
  if (error) return { erro: mensagemErroVotacao(error) };
  let apuracao = null;
  if (data?.existe && (data.gestao || data.status === "encerrada")) {
    const ap = await supabase.rpc("portal_logotipo_apuracao");
    apuracao = ap.error ? null : ap.data;
  }
  return { situacao: data, apuracao };
}

export default function VotacaoLogotipo() {
  const [situacao, setSituacao] = useState(null);
  const [apuracao, setApuracao] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  // Aplica o resultado da leitura. Só a gestão (ou a votação já encerrada)
  // recebe a contagem; para o operador com a votação aberta ela nem é pedida.
  const aplicar = useCallback((r) => {
    setCarregando(false);
    if (r.erro) {
      setErro(r.erro);
      return;
    }
    setSituacao(r.situacao);
    setApuracao(r.apuracao);
  }, []);

  const carregar = useCallback(() => lerVotacao().then(aplicar), [aplicar]);

  useEffect(() => {
    let vivo = true;
    lerVotacao().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [aplicar]);

  async function votar(numero) {
    if (ocupado || !situacao || situacao.minha_opcao || situacao.status !== "aberta") return;
    if (!window.confirm(`Confirmar seu voto na Proposta ${numero}? Depois de registrado, não é possível alterar.`)) return;
    setOcupado(true);
    setErro("");
    setAviso("");
    const { data, error } = await supabase.rpc("portal_logotipo_votar", { p_opcao: numero });
    setOcupado(false);
    if (error) {
      setErro(mensagemErroVotacao(error));
      await carregar();
      return;
    }
    setSituacao((s) => ({ ...s, minha_opcao: data?.minha_opcao ?? numero }));
    setAviso("Voto registrado. Obrigado por participar!");
  }

  async function encerrar() {
    if (ocupado) return;
    if (!window.confirm("Encerrar a votação? Depois disso ninguém mais vota e o resultado fica visível para toda a equipe.")) return;
    setOcupado(true);
    setErro("");
    const { error } = await supabase.rpc("portal_logotipo_encerrar");
    setOcupado(false);
    if (error) {
      setErro(mensagemErroVotacao(error));
      return;
    }
    setAviso("Votação encerrada.");
    await carregar();
  }

  if (carregando) {
    return <p style={{ color: "var(--rv-texto-suave)" }}>Carregando votação…</p>;
  }

  if (!situacao?.existe) {
    return (
      <div style={card}>
        <p style={{ margin: 0 }}>{erro || "A votação ainda não está disponível."}</p>
      </div>
    );
  }

  const aberta = situacao.status === "aberta";
  const minhaOpcao = situacao.minha_opcao;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={card}>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>
          Escolha o novo logotipo institucional da ReATIVA. Você tem <strong>um voto</strong>.
          Veja as quatro propostas com atenção antes de votar.
        </p>
        <p style={{ margin: "10px 0 0", fontSize: 14, color: "var(--rv-texto-suave)" }}>
          {aberta
            ? minhaOpcao
              ? `Votação aberta. Seu voto: Proposta ${minhaOpcao}.`
              : "Votação aberta. Você ainda não votou."
            : "Votação encerrada."}
        </p>
      </div>

      {aviso && <div role="status" style={{ ...card, borderColor: "var(--rv-verde-ok-borda)", background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)" }}>{aviso}</div>}
      {erro && <div role="alert" style={{ ...card, borderColor: "var(--rv-vermelho-borda)", background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)" }}>{erro}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 16 }}>
        {OPCOES_LOGOTIPO.map((o) => (
          <Quadro
            key={o.opcao}
            numero={o.opcao}
            titulo={o.titulo}
            imagem={o.imagem}
            selecionada={minhaOpcao === o.opcao}
            bloqueada={!aberta || Boolean(minhaOpcao)}
            ocupado={ocupado}
            onVotar={votar}
          />
        ))}
      </div>

      {!aberta && apuracao && (
        <div style={card}>
          <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Resultado final</h2>
          <Apuracao apuracao={apuracao} />
        </div>
      )}

      {situacao.gestao && (
        <section style={{ ...card, borderStyle: "dashed" }} aria-label="Acompanhamento da votação">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Acompanhamento (gestão)</h2>
            {aberta && (
              <button type="button" onClick={encerrar} disabled={ocupado} style={botao(true)}>
                Encerrar votação
              </button>
            )}
          </div>
          {apuracao ? (
            <Apuracao apuracao={apuracao} />
          ) : (
            <p style={{ margin: 0, color: "var(--rv-texto-suave)" }}>Não foi possível carregar a contagem agora.</p>
          )}
          <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--rv-texto-suave)" }}>
            Visível só para a gestão enquanto a votação está aberta.
          </p>
        </section>
      )}
    </div>
  );
}
