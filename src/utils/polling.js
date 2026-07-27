import { useEffect, useRef } from "react";

// Polling padrão do CRM. Resolve de uma vez os problemas que causavam
// travamento e consumo alto:
//  - pausa quando a aba está oculta (document.hidden) e roda na hora ao voltar;
//  - nunca dispara uma chamada nova se a anterior ainda está em andamento;
//  - cancela o timer ao desmontar o componente / trocar de tela;
//  - expõe uma função para atualizar na hora depois de uma ação relevante.
//
// Uso:
//   const atualizarAgora = usePolling(carregar, 45000, [usuario], Boolean(usuario));
export default function usePolling(fn, intervaloMs, deps = [], ativo = true) {
  const fnRef = useRef(fn);
  const rodandoRef = useRef(false);
  const dispararRef = useRef(() => {});

  fnRef.current = fn;

  useEffect(() => {
    if (!ativo) return undefined;

    let cancelado = false;

    async function executar() {
      // Sem sobreposição: se ainda tem uma chamada em voo, ignora este tick.
      if (rodandoRef.current || cancelado) return;
      rodandoRef.current = true;
      try {
        await fnRef.current();
      } catch (e) {
        if (!cancelado) console.warn("Erro no polling:", e);
      } finally {
        rodandoRef.current = false;
      }
    }

    dispararRef.current = executar;

    function tick() {
      // Aba oculta: não gasta requisição. Volta a rodar em aoVoltarFoco.
      if (document.hidden) return;
      executar();
    }

    executar();
    const timer = setInterval(tick, intervaloMs);

    // Contenção de rajada: o disparo ao voltar o foco é DEBOUNCED. Sem isto,
    // vários operadores voltando à aba ao mesmo tempo (ou trocas rápidas de
    // foco) disparavam a mesma RPC em enxame, contribuindo para a saturação.
    let focoTimer = null;
    function aoVoltarFoco() {
      if (document.visibilityState !== "visible") return;
      if (focoTimer) return; // já há um disparo agendado
      focoTimer = setTimeout(() => {
        focoTimer = null;
        executar();
      }, 3000);
    }
    document.addEventListener("visibilitychange", aoVoltarFoco);
    window.addEventListener("focus", aoVoltarFoco);

    return () => {
      cancelado = true;
      clearInterval(timer);
      if (focoTimer) clearTimeout(focoTimer);
      document.removeEventListener("visibilitychange", aoVoltarFoco);
      window.removeEventListener("focus", aoVoltarFoco);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervaloMs, ativo, ...deps]);

  return () => dispararRef.current();
}
