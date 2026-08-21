// Faixa "Dá para desfazer" na ficha do aluno.
//
// Mostra as ações recém-feitas que ainda podem voltar atrás (termo enviado ao
// ADM, link solicitado, tabulação) e o botão que desfaz. O que pode ou não ser
// desfeito é decidido no banco -- aqui só desenhamos o que a RPC devolveu.
//
// Ação bloqueada há pouco tempo continua aparecendo, apagada, com o motivo: sem
// isso o botão simplesmente sumiria e o operador ficaria sem saber por quê.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { listarDesfazer, desfazerAcao, explicarBloqueio, TIPO_ROTULO } from "../utils/desfazer";

const JANELA_EXPLICACAO_MIN = 15;

function minutosDesde(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function quandoFoi(iso) {
  const min = minutosDesde(iso);
  if (min < 1) return "agora";
  if (min < 60) return `há ${Math.floor(min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return new Date(iso).toLocaleString("pt-BR");
}

// O aviso muda por tipo porque a consequência muda: só o termo apaga arquivo.
function textoConfirmacao(acao) {
  if (acao.tipo === "TERMO_ENVIADO") {
    return (
      `Desfazer o envio do termo de ${acao.aluno_nome || "este aluno"}?\n\n` +
      "O termo sai da fila do ADM e os anexos (termo e RG) serão APAGADOS — " +
      "documento na ficha errada não pode ficar guardado.\n\n" +
      "Depois é só enviar de novo, na ficha certa."
    );
  }
  if (acao.tipo === "LINK_SOLICITADO") {
    return (
      `Desfazer a solicitação de link de ${acao.aluno_nome || "este aluno"}?\n\n` +
      "A solicitação sai da fila do ADM e a ficha volta ao status anterior."
    );
  }
  return (
    `Desfazer esta tabulação de ${acao.aluno_nome || "este aluno"}?\n\n` +
    "A ficha volta ao status, retorno e observação que tinha antes, e o " +
    "atendimento deixa de contar como acionamento."
  );
}

export default function PainelDesfazer({ alunoId, atualizarEm = 0, onDesfeito }) {
  const [itens, setItens] = useState([]);
  const [emailAtual, setEmailAtual] = useState("");
  const [processando, setProcessando] = useState("");
  const [aviso, setAviso] = useState(null);

  useEffect(() => {
    let vivo = true;
    supabase.auth.getUser().then(({ data }) => {
      if (vivo) setEmailAtual((data?.user?.email || "").toLowerCase());
    });
    return () => { vivo = false; };
  }, []);

  // Recarga usada pelos handlers (depois de desfazer). O efeito abaixo tem a
  // sua propria copia: chamar esta aqui dentro dele faria setState sincrono no
  // corpo do efeito, que e justamente o que dispara render em cascata.
  const carregar = useCallback(async () => {
    if (!alunoId) return;
    const res = await listarDesfazer(alunoId, 10);
    setItens(res.ok ? res.itens : []);
  }, [alunoId]);

  useEffect(() => {
    if (!alunoId) return undefined;
    let vivo = true;
    (async () => {
      const res = await listarDesfazer(alunoId, 10);
      if (vivo) setItens(res.ok ? res.itens : []);
    })();
    return () => { vivo = false; };
  }, [alunoId, atualizarEm]);

  async function clicarDesfazer(acao) {
    if (!window.confirm(textoConfirmacao(acao))) return;

    // Gestão desfazendo ação de outro operador precisa dizer por quê -- é ela
    // que responde pelo histórico depois. A RPC recusa sem motivo.
    let motivo = null;
    if (emailAtual && acao.operador_email && acao.operador_email !== emailAtual) {
      motivo = window.prompt("Motivo para desfazer a ação de outro operador:");
      if (!motivo || !motivo.trim()) {
        setAviso({ tipo: "erro", texto: "Desfazer cancelado: o motivo é obrigatório." });
        return;
      }
    }

    setProcessando(acao.id);
    const res = await desfazerAcao(acao, motivo);
    setProcessando("");

    if (!res.ok) {
      setAviso({ tipo: "erro", texto: res.erro });
      carregar();
      return;
    }

    setAviso({
      tipo: "ok",
      texto:
        "Desfeito." +
        (res.statusRestaurado ? ` A ficha voltou para "${res.statusRestaurado}".` : "") +
        (res.anexosPendentes > 0
          ? ` Atenção: ${res.anexosPendentes} anexo(s) não saíram do arquivo e ficaram registrados para nova tentativa.`
          : ""),
    });
    carregar();
    if (onDesfeito) onDesfeito(res);
  }

  // Bloqueadas antigas não interessam a ninguém: só explicamos as recentes.
  const visiveis = itens.filter(
    (i) => !i.bloqueio || minutosDesde(i.criado_em) <= JANELA_EXPLICACAO_MIN
  );

  if (visiveis.length === 0 && !aviso) return null;

  return (
    <div style={S.caixa}>
      <div style={S.titulo}>Dá para desfazer</div>

      {aviso && (
        <div style={{ ...S.aviso, ...(aviso.tipo === "erro" ? S.avisoErro : S.avisoOk) }}>
          {aviso.texto}
        </div>
      )}

      {visiveis.map((acao) => (
        <div key={acao.id} style={S.linha}>
          <span style={S.tag}>{TIPO_ROTULO[acao.tipo] || acao.tipo}</span>
          <span style={S.rotulo}>{acao.rotulo}</span>
          <span style={S.quando}>{quandoFoi(acao.criado_em)}</span>

          {acao.bloqueio ? (
            <span style={S.bloqueio}>{explicarBloqueio(acao.bloqueio)}</span>
          ) : (
            <button
              type="button"
              onClick={() => clicarDesfazer(acao)}
              disabled={processando === acao.id}
              style={{ ...S.botao, ...(processando === acao.id ? S.botaoOff : null) }}
            >
              {processando === acao.id ? "Desfazendo…" : "↺ Desfazer"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const S = {
  caixa: {
    border: "1px solid #fed7aa",
    background: "#fff7ed",
    borderRadius: 12,
    padding: "10px 12px",
    marginBottom: 12,
  },
  titulo: { fontSize: 12, fontWeight: 800, color: "#9a3412", marginBottom: 8, letterSpacing: 0.3 },
  linha: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "4px 0" },
  tag: {
    fontSize: 11,
    fontWeight: 800,
    color: "#9a3412",
    background: "#ffedd5",
    border: "1px solid #fed7aa",
    borderRadius: 999,
    padding: "2px 8px",
  },
  rotulo: { fontSize: 13, color: "#1f2937", fontWeight: 600 },
  quando: { fontSize: 12, color: "#78716c" },
  bloqueio: { fontSize: 12, color: "#78716c", fontStyle: "italic" },
  botao: {
    marginLeft: "auto",
    background: "#c2410c",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  botaoOff: { background: "#a8a29e", cursor: "default" },
  aviso: { fontSize: 12, fontWeight: 600, borderRadius: 8, padding: "6px 10px", marginBottom: 6 },
  avisoOk: { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" },
  avisoErro: { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" },
};
