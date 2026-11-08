import { useCallback, useEffect, useMemo, useState } from "react";
import usePolling from "../utils/polling";
import { doResponsavel, naoLidas, amostraSimulada } from "../utils/ulbraRespostas";
import { lerLidoAte, gravarLidoAte, carregarReal } from "../utils/ulbraRespostasFonte";

// Aviso de "o aluno respondeu" na Mensageria Ulbra.
//
// O SINAL É MENSAGEM DE VERDADE. A última mensagem da conversa é do cliente —
// medido por `listar_conversas` / `ler_conversa` (`quem`, `em`, `id`). Não é
// mais `situacao === "waiting"` nem `atualizadoEm`, que eram proxies e saíram.
//
// O NAVEGADOR NÃO FALA COM A MENSAGERIA. Ele lê o Postgres, que não gasta o
// orçamento de 500/dia. Quem fala com a Mensageria é uma sincronização
// central; sem ela, cada navegador multiplicaria as chamadas (9 operadores a
// cada 10 min dariam 648/dia). Por isso o intervalo abaixo é do refresh da
// TELA contra o nosso banco, não da ida à ULBRA.
const INTERVALO_MS = 2 * 60_000;

export default function NotificacoesUlbra({
  onAssumirLead,
  email = "",
  gestao = false,
  simulado = false,
  carregar,
}) {
  const [itens, setItens] = useState([]);
  const [indisponivel, setIndisponivel] = useState(false);
  const [aberto, setAberto] = useState(false);
  const [lidoAte, setLidoAte] = useState(null);

  useEffect(() => {
    let vivo = true;
    lerLidoAte(email).then((v) => { if (vivo) setLidoAte(v); });
    return () => { vivo = false; };
  }, [email]);

  const fonte = useMemo(() => {
    if (carregar) return carregar;
    // Simulado e real ficam SEPARADOS: nada de amostra vazando para o caminho
    // real nem de fallback silencioso de um para o outro.
    if (simulado) {
      return async () => ({ itens: amostraSimulada(Date.now(), email || undefined), indisponivel: false });
    }
    return carregarReal;
  }, [carregar, simulado, email]);

  const buscar = useCallback(async () => {
    try {
      const r = await fonte();
      const lista = Array.isArray(r) ? r : (r?.itens ?? []);
      setItens(lista);
      setIndisponivel(Array.isArray(r) ? false : Boolean(r?.indisponivel));
    } catch {
      setItens([]);
      setIndisponivel(true);
    }
  }, [fonte]);

  usePolling(buscar, INTERVALO_MS, [fonte], true);

  const meus = useMemo(() => doResponsavel(itens, { email, gestao }), [itens, email, gestao]);
  const novas = useMemo(() => naoLidas(meus, { lidoAte }), [meus, lidoAte]);
  // A lista mostra TODAS as que esperam resposta, lidas ou não: um aluno
  // esperando não some da operação só porque alguém já olhou.
  const esperando = useMemo(() => naoLidas(meus, {}), [meus]);

  async function alternar() {
    const abrindo = !aberto;
    setAberto(abrindo);
    if (abrindo) {
      const agora = new Date().toISOString();
      setLidoAte(agora);
      await gravarLidoAte(email, agora);
    }
  }

  // Sem ninguém esperando — e sem nada a dizer sobre indisponibilidade — a
  // barra lateral não ganha ruído.
  if (esperando.length === 0 && !indisponivel) return null;

  // Fonte real indisponível (a migration do cache ainda não foi aplicada):
  // dizer isso é melhor do que mostrar zero como se estivesse tudo lido.
  if (esperando.length === 0 && indisponivel) {
    return (
      <div style={S.caixa}>
        <div style={S.inativo} title="Depende da migration 20261108120000, ainda não aplicada">
          💬 Respostas: fonte não ligada
        </div>
      </div>
    );
  }

  return (
    <div style={S.caixa}>
      <button style={S.btn} onClick={alternar} title="Alunos que responderam na Mensageria Ulbra">
        💬 Responderam
        {novas.length > 0 ? <span style={S.badge}>{novas.length}</span> : null}
      </button>

      {aberto && (
        <div style={S.painel}>
          <div style={S.cabecalho}>
            Responderam e aguardam
            {simulado ? <span style={S.selo}>SIMULADO</span> : null}
          </div>
          {esperando.map((item) => (
            <div key={item.conversa_id} style={S.linha}>
              <span style={S.nome}>{item.aluno_nome || item.cliente_nome || "Sem nome"}</span>
              <button
                style={S.assumir}
                onClick={() => {
                  onAssumirLead?.(item);
                  setAberto(false);
                }}
              >
                Abrir
              </button>
            </div>
          ))}
          <div style={S.rodape}>
            {simulado
              ? "Amostra: nenhuma chamada à Mensageria e nenhuma mensagem enviada."
              : "A última mensagem da conversa é do aluno. O texto fica na Mensageria — abra o cadastro para ler."}
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  caixa: { position: "relative", marginTop: 10, padding: "0 10px" },
  btn: { position: "relative", width: "100%", background: "transparent", border: "1px solid rgba(148,163,184,0.3)", color: "#93c5fd", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  inativo: { width: "100%", textAlign: "center", border: "1px dashed rgba(148,163,184,0.25)", color: "#64748b", borderRadius: 999, padding: "6px 10px", fontSize: 11, fontWeight: 600 },
  badge: { position: "absolute", top: -6, right: -6, background: "#dc2626", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" },
  painel: { position: "absolute", left: 10, right: 10, bottom: "calc(100% + 6px)", background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-forte)", borderRadius: 10, boxShadow: "0 10px 30px rgba(2,6,23,0.35)", zIndex: 50, overflow: "hidden" },
  cabecalho: { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", fontSize: 11, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)" },
  selo: { background: "var(--rv-ambar-texto)", color: "#fff", borderRadius: 999, padding: "1px 7px", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.06em" },
  linha: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 10px" },
  nome: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  assumir: { background: "var(--rv-superficie)", color: "var(--rv-azul-texto)", border: "1px solid var(--rv-azul-borda)", borderRadius: 8, padding: "4px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  rodape: { padding: "8px 10px", fontSize: 10.5, lineHeight: 1.4, color: "var(--rv-texto-fraco)", borderTop: "1px solid var(--rv-borda-suave)" },
};
