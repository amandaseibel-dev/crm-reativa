import { useCallback, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { chamarRpcContido } from "../utils/rpcResiliente";

// Analitica SOB DEMANDA: nao roda sozinha (sem auto-load no mount, sem polling).
// So executa quando o usuario clica em "Atualizar". Isso remove a carga continua
// que saturava o Supabase (incidente P0) -- cada clique dispara UMA consulta.
//
// Protecoes:
//  - emVoo: ignora cliques enquanto uma atualizacao esta em andamento;
//  - cooldown: intervalo minimo entre atualizacoes (evita marteladas no botao);
//  - chamarRpcContido: timeout local, single-flight e cache curto ja embutidos.
//
// Uso:
//   const { data, carregando, erro, ultimaEm, atualizar, jaRodou } =
//     useAnaliticaSobDemanda("dashboard_carteira_360");
export function useAnaliticaSobDemanda(nomeRpc, params = {}, opcoes = {}) {
  const { cooldownMs = 15000, cacheMs = 0, timeoutMs = 12000 } = opcoes;

  const [data, setData] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [ultimaEm, setUltimaEm] = useState(null);

  const emVoo = useRef(false);
  const bloqueadoAte = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const atualizar = useCallback(async () => {
    const agora = Date.now();
    if (emVoo.current || agora < bloqueadoAte.current) return;
    emVoo.current = true;
    bloqueadoAte.current = agora + cooldownMs;
    setCarregando(true);
    setErro("");
    try {
      const { data: d, error } = await chamarRpcContido(
        supabase,
        nomeRpc,
        paramsRef.current,
        { cacheMs, timeoutMs }
      );
      if (error) {
        setErro("Não foi possível atualizar agora. Tente novamente em instantes.");
      } else {
        setData(d);
        setUltimaEm(new Date());
      }
    } finally {
      emVoo.current = false;
      setCarregando(false);
    }
  }, [nomeRpc, cooldownMs, cacheMs, timeoutMs]);

  return { data, carregando, erro, ultimaEm, atualizar, jaRodou: ultimaEm !== null };
}
