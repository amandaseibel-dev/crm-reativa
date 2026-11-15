// Painel SOMENTE LEITURA do histórico ULBRA. Sem conexão, sem prévia, sem envio, sem autorização externa.
// Consulta somente por clique: montar ou selecionar a conversa NÃO chama a função.
import { useState } from "react";
import { lerHistorico, mapearHistorico } from "../utils/ulbraHistoricoCliente";

export default function HistoricoUlbraLeitura({ conversaId, leitor = lerHistorico }) {
  const [historico, setHistorico] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  async function carregar(antesDe = null) {
    if (!conversaId || ocupado) return;
    setOcupado(true);
    try {
      const resposta = await leitor(conversaId, antesDe);
      setHistorico((anterior) => mapearHistorico(resposta, antesDe ? anterior : null));
    } finally {
      setOcupado(false);
    }
  }

  if (!historico) {
    return (
      <div>
        <button type="button" onClick={() => carregar()} disabled={!conversaId || ocupado}>
          {ocupado ? "Carregando…" : "Carregar histórico"}
        </button>
        <p>A leitura usa uma consulta à Mensageria. Só é feita quando você clica.</p>
      </div>
    );
  }

  return (
    <div>
      {historico.erro && <p role="alert">{historico.erro}</p>}
      {historico.mensagens.length === 0 && historico.estado === "vazio" && <p>Nenhuma mensagem nesta conversa.</p>}
      <ul>
        {historico.mensagens.map((m, i) => (
          <li key={i}>
            <small>{m.em} · {m.autor || m.direcao}</small>
            <div>{m.texto}</div>
          </li>
        ))}
      </ul>
      {historico.antesDe && (
        <button type="button" onClick={() => carregar(historico.antesDe)} disabled={ocupado}>
          {ocupado ? "Carregando…" : "Carregar mais"}
        </button>
      )}
    </div>
  );
}
