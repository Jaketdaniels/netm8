import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function useHealth() {
	return useQuery({
		queryKey: ["health"],
		queryFn: async () => {
			const res = await api.api.health.$get();
			return res.json();
		},
		refetchInterval: 60_000,
		retry: false,
	});
}
