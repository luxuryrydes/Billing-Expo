import { useQuery } from '@tanstack/react-query';
import { api, qs } from './api';

export interface Client { id: string; name: string; short_code: string; status: string; [k: string]: any }
export interface Contract { id: string; client_id: string; client_name: string; client_code: string; title: string; reference_no: string; status: string; start_date: string; end_date: string | null; custom_fields: { key: string; label: string; type: string; required: boolean }[]; [k: string]: any }
export interface Category { id: string; name: string }
export interface DutyType { code: string; name: string }

export const useClients = () => useQuery({ queryKey: ['clients'], queryFn: () => api.get<Client[]>('/clients') });
export const useContracts = (clientId?: string) => useQuery({ queryKey: ['contracts', clientId ?? ''], queryFn: () => api.get<Contract[]>(`/contracts${qs({ clientId })}`) });
export const useCategories = () => useQuery({ queryKey: ['vehicle-categories'], queryFn: () => api.get<Category[]>('/vehicle-categories') });
export const useDutyTypes = () => useQuery({ queryKey: ['duty-types'], queryFn: () => api.get<DutyType[]>('/duty-types') });
export const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<any[]>('/suppliers') });
