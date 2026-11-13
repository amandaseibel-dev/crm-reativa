// ===========================================================================
// Conversa da Mensageria na FICHA do aluno (piloto). Somente leitura.
// Abrir a ficha NÃO chama a Mensageria: só o clique em "Consultar" chama, uma
// vez por página. Mostra a data e a hora da consulta e de cada mensagem, e
// deixa claro que é a Mensageria no momento da consulta, não um espelho salvo.
// ===========================================================================
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { lerHistoricoDoAluno, mapearHistorico, MOTIVOS_HISTORICO } from "../utils/ulbraHistoricoCliente";
import { podeVerHistoricoNaFicha } from "../utils/ulbraHistorico";

function dataHora(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

const ROTULO_DIRECAO = { ENTRADA: "Aluno", SAIDA: "Equipe", AUTOMATICA: "Automática", SISTEMA: "Sistema" };

export default function HistoricoFichaAluno({ alunoId, emailUsuario, leitor = lerHistoricoDoAluno }) {
  const [email, setEmail] = useState(emailUsuario ?? null);
  const [historico, setHistorico] = useState(null);
  const [consultadoEm, setConsultadoEm] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (emailUsuario !== undefined) return undefined;
    let vivo = true;
    const sessao = supabase?.auth?.getUser?.();
    if (sessao && typeof sessao.then === "function") {
      sessao.then(({ data }) => { if (vivo) setEmail(data?.user?.email ?? null); }).catch(() => {});
    }
    return () => { vivo = false; };
  }, [emailUsuario]);

  if (!alunoId || !podeVerHistoricoNaFicha(email)) return null;

  async function consultar(antesDe = null) {
    if (ocupado) return;
    setOcupado(true);
    try {
      const resposta = await leitor(alunoId, antesDe);
      if (resposta?.consultado_em) setConsultadoEm(resposta.consultado_em);
      setHistorico((anterior) => mapearHistorico(resposta, antesDe ? anterior : null));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section data-testid="historico-ficha" style={{ marginTop: 12 }}>
      {historico === null ? (
        <button type="button" data-campo="consultar-historico" disabled={ocupado} onClick={() => consultar()}>
          {ocupado ? "Consultando…" : "Consultar conversa na Mensageria (1 consulta)"}
        </button>
      ) : (
        <div>
          {consultadoEm ? (
            <p data-campo="consultado-em">
              Consultado na Mensageria em <strong>{dataHora(consultadoEm)}</strong>. Não é um espelho salvo.
            </p>
          ) : null}
          {historico.erro ? <p role="alert">{historico.erro}</p> : null}
          {historico.estado === "vazio" ? <p>Nenhuma mensagem nesta conversa.</p> : null}
          <ul data-campo="mensagens">
            {historico.mensagens.map((m, i) => (
              <li key={i}>
                <small>{dataHora(m.em)} · {ROTULO_DIRECAO[m.direcao] ?? m.direcao}</small>
                <div>{m.texto}</div>
              </li>
            ))}
          </ul>
          {historico.antesDe ? (
            <button type="button" disabled={ocupado} onClick={() => consultar(historico.antesDe)}>
              {ocupado ? "Consultando…" : "Carregar mensagens anteriores (1 consulta)"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export { MOTIVOS_HISTORICO };
