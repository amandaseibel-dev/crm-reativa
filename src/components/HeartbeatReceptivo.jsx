import { useEffect } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

// Mantém o operador "online" na fila do receptivo enquanto ele estiver
// logado no sistema, em qualquer tela -- antes o heartbeat só rodava
// dentro do widget da Fila Operacional, então quem saía pra atender um
// aluno em outra tela (Aluno, CRM, etc.) caía como "offline" em 90s e
// sumia da fila, mesmo trabalhando normalmente. Este componente não
// renderiza nada, só mantém o heartbeat vivo em segundo plano.
export default function HeartbeatReceptivo({ usuario }) {
  const email = usuario?.perfil?.email || usuario?.auth?.email || "";
  const ehReceptivo = Boolean(usuario?.perfil?.receptivo);

  useEffect(() => {
    if (!ehReceptivo || !email) return;

    let cancelado = false;

    async function bater() {
      try {
        // Refresh proativo: se a aba ficou muito tempo parada/em segundo
        // plano, o token pode ter expirado e o RPC falharia silenciosamente,
        // parando de atualizar online_em sem nunca lançar erro visível.
        try {
          await supabase.auth.getSession();
        } catch {}

        await supabase.rpc("fila_receptivo_heartbeat", {
          p_email: email,
          p_nome: nomeOperadorPorEmail(email),
        });
      } catch (e) {
        if (!cancelado) console.warn("Erro no heartbeat do receptivo:", e);
      }
    }

    bater();
    const intervalo = setInterval(bater, 20000);

    // Se o navegador atrasou o setInterval (aba em segundo plano) e o
    // operador volta pra aba, bate na hora em vez de esperar o próximo
    // tick atrasado.
    function aoVoltarFoco() {
      if (document.visibilityState === "visible") bater();
    }
    document.addEventListener("visibilitychange", aoVoltarFoco);
    window.addEventListener("focus", aoVoltarFoco);

    return () => {
      cancelado = true;
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", aoVoltarFoco);
      window.removeEventListener("focus", aoVoltarFoco);
    };
  }, [ehReceptivo, email]);

  return null;
}
